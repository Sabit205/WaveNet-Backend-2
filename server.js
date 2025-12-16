require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const cors = require('cors');
const CallLog = require('./models/CallLog');
const { requireAuth } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true
}));
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error(err));

// --- REST API Routes ---
app.get('/api/history/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.auth.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    const logs = await CallLog.find({
      $or: [{ callerId: userId }, { receiverId: userId }]
    }).sort({ startTime: -1 }).limit(50);
    res.json(logs);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Socket.io Setup ---
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST"]
  }
});

// Map<userId, { socketId, userInfo }>
const onlineUsers = new Map();

io.on('connection', (socket) => {
  // 1. User Online (Now accepts userInfo)
  socket.on('user-online', ({ userId, userInfo }) => {
    onlineUsers.set(userId, { socketId: socket.id, userInfo });
    socket.join(userId);
    
    // Broadcast list of users with their info
    const usersList = Array.from(onlineUsers.entries()).map(([id, data]) => ({
      userId: id,
      userInfo: data.userInfo
    }));
    io.emit('online-users', usersList);
  });

  // 2. Initiate Call
  socket.on('call-user', async (data) => {
    const { caller, receiverId, callType } = data;
    
    const receiverData = onlineUsers.get(receiverId);
    
    if (receiverData) {
      // Create log with FULL details immediately
      const log = new CallLog({
        callerId: caller.id,
        callerName: caller.name,
        callerAvatar: caller.avatar,
        receiverId: receiverId,
        receiverName: receiverData.userInfo.name, // Got name from online map
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

  // 3. Answer Call
  socket.on('call-accepted', async (data) => {
    const { callerId, receiver, callId } = data; 
    
    // Update log to accepted
    await CallLog.findByIdAndUpdate(callId, {
      status: 'accepted',
      startTime: new Date() // Reset start time to actual talk start
    });

    const callerData = onlineUsers.get(callerId);
    if (callerData) {
      io.to(callerData.socketId).emit('call-accepted', { receiver });
    }
  });

  // 4. Reject Call
  socket.on('call-rejected', async (data) => {
    const { callerId, callId } = data;
    if(callId) {
      await CallLog.findByIdAndUpdate(callId, { status: 'rejected', endTime: new Date() });
    }
    const callerData = onlineUsers.get(callerId);
    if (callerData) {
      io.to(callerData.socketId).emit('call-rejected');
    }
  });

  // 5. Cancel Call
  socket.on('cancel-call', async (data) => {
    const { receiverId, callId } = data;
    if(callId) {
      await CallLog.findByIdAndUpdate(callId, { status: 'canceled', endTime: new Date() });
    }
    const receiverData = onlineUsers.get(receiverId);
    if (receiverData) {
      io.to(receiverData.socketId).emit('call-cancelled');
    }
  });

  // 6. WebRTC Signaling
  socket.on('webrtc-offer', (data) => {
    const { target, offer } = data;
    const targetData = onlineUsers.get(target);
    if (targetData) io.to(targetData.socketId).emit('webrtc-offer', { offer });
  });

  socket.on('webrtc-answer', (data) => {
    const { target, answer } = data;
    const targetData = onlineUsers.get(target);
    if (targetData) io.to(targetData.socketId).emit('webrtc-answer', { answer });
  });

  socket.on('ice-candidate', (data) => {
    const { target, candidate } = data;
    const targetData = onlineUsers.get(target);
    if (targetData) io.to(targetData.socketId).emit('ice-candidate', { candidate });
  });

  // 7. End Call
  socket.on('end-call', async (data) => {
    const { targetId, callId } = data;
    if (callId) {
      await CallLog.findByIdAndUpdate(callId, { endTime: new Date() });
    }
    const targetData = onlineUsers.get(targetId);
    if (targetData) {
      io.to(targetData.socketId).emit('end-call');
    }
  });

  socket.on('disconnect', () => {
    for (let [userId, data] of onlineUsers.entries()) {
      if (data.socketId === socket.id) {
        onlineUsers.delete(userId);
        const usersList = Array.from(onlineUsers.entries()).map(([id, d]) => ({
          userId: id,
          userInfo: d.userInfo
        }));
        io.emit('online-users', usersList);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Backend running on port ${PORT}`));