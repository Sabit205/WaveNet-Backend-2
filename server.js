require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const cors = require('cors');
const CallLog = require('./models/CallLog');
const User = require('./models/User');
const { requireAuth } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error(err));

// --- API ROUTES ---

// 1. Sync User (Called on Frontend Login)
app.post('/api/sync-user', requireAuth, async (req, res) => {
  const { id, fullName, imageUrl, emailAddresses } = req.body;
  try {
    let user = await User.findOne({ clerkId: id });
    if (!user) {
      user = new User({
        clerkId: id,
        name: fullName,
        image: imageUrl,
        email: emailAddresses[0]?.emailAddress
      });
      await user.save();
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: "Sync failed" });
  }
});

// 2. Search Users
app.get('/api/users/search', requireAuth, async (req, res) => {
  const { query } = req.query;
  try {
    const users = await User.find({
      $or: [
        { name: { $regex: query, $options: 'i' } },
        { email: { $regex: query, $options: 'i' } }
      ],
      clerkId: { $ne: req.auth.userId } // Exclude self
    }).select('clerkId name image');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Search failed" });
  }
});

// 3. Send Friend Request
app.post('/api/friends/request', requireAuth, async (req, res) => {
  const { targetId } = req.body;
  const senderId = req.auth.userId;
  
  try {
    await User.findOneAndUpdate(
      { clerkId: targetId },
      { $addToSet: { friendRequests: { from: senderId, status: 'pending' } } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Request failed" });
  }
});

// 4. Accept/Reject Friend Request
app.post('/api/friends/respond', requireAuth, async (req, res) => {
  const { requesterId, action } = req.body; // action: 'accept' or 'reject'
  const userId = req.auth.userId;

  try {
    const user = await User.findOne({ clerkId: userId });
    
    // Remove request
    user.friendRequests = user.friendRequests.filter(req => req.from !== requesterId);
    
    if (action === 'accept') {
      user.friends.push(requesterId);
      // Add reverse friendship
      await User.findOneAndUpdate({ clerkId: requesterId }, { $addToSet: { friends: userId } });
    }
    
    await user.save();
    res.json({ success: true, friends: user.friends });
  } catch (err) {
    res.status(500).json({ error: "Action failed" });
  }
});

// 5. Get My Details (Friends & Requests)
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId }).lean();
    if(!user) return res.status(404).json({error: "User not found"});

    // Populate friends details
    const friends = await User.find({ clerkId: { $in: user.friends } }).select('clerkId name image');
    // Populate requests details
    const requests = await Promise.all(user.friendRequests.map(async (r) => {
      const u = await User.findOne({ clerkId: r.from }).select('clerkId name image');
      return u;
    }));

    res.json({ friends, requests: requests.filter(Boolean) });
  } catch (err) {
    res.status(500).json({ error: "Fetch failed" });
  }
});

// 6. Call History
app.get('/api/history/:userId', requireAuth, async (req, res) => {
  if (req.auth.userId !== req.params.userId) return res.status(403).json({ error: "Unauthorized" });
  const logs = await CallLog.find({
    $or: [{ callerId: req.params.userId }, { receiverId: req.params.userId }]
  }).sort({ startTime: -1 }).limit(50);
  res.json(logs);
});

// --- SOCKET LOGIC ---
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL, methods: ["GET", "POST"] }
});

const onlineUsers = new Map(); // userId -> { socketId, userInfo }

io.on('connection', (socket) => {
  
  socket.on('user-online', ({ userId, userInfo }) => {
    onlineUsers.set(userId, { socketId: socket.id, userInfo });
    socket.join(userId);
    // Broadcast online status to everyone (Frontend filters friends)
    io.emit('online-users', Array.from(onlineUsers.keys())); 
  });

  socket.on('call-user', async (data) => {
    const { caller, receiverId, callType } = data;
    
    // CHECK FRIENDSHIP
    const receiverUser = await User.findOne({ clerkId: receiverId });
    if (!receiverUser || !receiverUser.friends.includes(caller.id)) {
      socket.emit('call-error', { message: "You can only call friends." });
      return;
    }

    const receiverData = onlineUsers.get(receiverId);
    if (receiverData) {
      const log = new CallLog({
        callerId: caller.id,
        callerName: caller.name,
        callerAvatar: caller.avatar,
        receiverId: receiverId,
        receiverName: receiverData.userInfo.name,
        receiverAvatar: receiverData.userInfo.imageUrl,
        callType,
        status: 'missed' 
      });
      await log.save();

      io.to(receiverData.socketId).emit('incoming-call', {
        caller,
        callType,
        callId: log._id
      });
    } else {
      socket.emit('call-error', { message: 'User is offline' });
    }
  });

  socket.on('call-accepted', async ({ callerId, receiver, callId }) => {
    // Reset start time to NOW to fix duration bug on rejected calls
    await CallLog.findByIdAndUpdate(callId, { status: 'accepted', startTime: new Date() });
    
    const callerData = onlineUsers.get(callerId);
    if (callerData) io.to(callerData.socketId).emit('call-accepted', { receiver });
  });

  socket.on('call-rejected', async ({ callerId, callId }) => {
    // Rejected calls don't need valid duration, endTime = startTime roughly
    await CallLog.findByIdAndUpdate(callId, { status: 'rejected', endTime: new Date() });
    const callerData = onlineUsers.get(callerId);
    if (callerData) io.to(callerData.socketId).emit('call-rejected');
  });

  socket.on('cancel-call', async ({ receiverId, callId }) => {
    await CallLog.findByIdAndUpdate(callId, { status: 'canceled', endTime: new Date() });
    const receiverData = onlineUsers.get(receiverId);
    if (receiverData) io.to(receiverData.socketId).emit('call-cancelled');
  });

  // Toggle Camera Event (For UI Sync)
  socket.on('toggle-media', ({ targetId, kind, enabled }) => {
     const targetData = onlineUsers.get(targetId);
     if(targetData) io.to(targetData.socketId).emit('remote-media-state', { kind, enabled });
  });

  // WebRTC
  socket.on('webrtc-offer', (data) => {
    const target = onlineUsers.get(data.target);
    if (target) io.to(target.socketId).emit('webrtc-offer', { offer: data.offer });
  });
  
  socket.on('webrtc-answer', (data) => {
    const target = onlineUsers.get(data.target);
    if (target) io.to(target.socketId).emit('webrtc-answer', { answer: data.answer });
  });
  
  socket.on('ice-candidate', (data) => {
    const target = onlineUsers.get(data.target);
    if (target) io.to(target.socketId).emit('ice-candidate', { candidate: data.candidate });
  });

  socket.on('end-call', async ({ targetId, callId }) => {
    if (callId) await CallLog.findByIdAndUpdate(callId, { endTime: new Date() });
    const target = onlineUsers.get(targetId);
    if (target) io.to(target.socketId).emit('end-call');
  });

  socket.on('disconnect', () => {
    for (let [uid, d] of onlineUsers.entries()) {
      if (d.socketId === socket.id) {
        onlineUsers.delete(uid);
        io.emit('online-users', Array.from(onlineUsers.keys()));
        break;
      }
    }
  });
});

server.listen(5000, () => console.log('Backend on 5000'));