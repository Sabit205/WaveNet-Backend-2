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

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true
}));
app.use(express.json());

// Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error(err));

// --- REST API Routes ---

// Get Call History for a specific user
app.get('/api/history/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    // Ensure the requester is requesting their own history
    if (req.auth.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized access to history" });
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

// Create/Update Call Log (Called via API or internally via Socket logic if preferred)
// For this architecture, we will update logs via Socket events for accuracy
// but expose an endpoint just in case.

// --- Socket.io Setup ---
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST"]
  }
});

// State for Online Users: Map<userId, socketId>
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log(`Socket Connected: ${socket.id}`);

  // 1. User Online
  socket.on('user-online', (userId) => {
    onlineUsers.set(userId, socket.id);
    socket.join(userId); // Join a room with their Clerk ID
    
    // Broadcast list of online user IDs
    io.emit('online-users', Array.from(onlineUsers.keys()));
  });

  // 2. Initiate Call
  socket.on('call-user', async (data) => {
    const { caller, receiverId, callType } = data;
    // data.caller = { id, name, avatar }
    
    const receiverSocketId = onlineUsers.get(receiverId);
    
    if (receiverSocketId) {
      // Create initial log entry
      const log = new CallLog({
        callerId: caller.id,
        callerName: caller.name,
        callerAvatar: caller.avatar,
        receiverId: receiverId,
        receiverName: "Unknown", // Will update when receiver responds or we fetch
        receiverAvatar: "",
        callType,
        status: 'missed' // Default until accepted
      });
      await log.save();

      io.to(receiverSocketId).emit('incoming-call', {
        caller,
        callType,
        callId: log._id
      });
    } else {
      // User offline
      socket.emit('call-error', { message: 'User is offline' });
    }
  });

  // 3. Answer Call
  socket.on('call-accepted', async (data) => {
    const { callerId, receiver, callId } = data; 
    // receiver = { id, name, avatar }

    // Update log status
    await CallLog.findByIdAndUpdate(callId, {
      status: 'accepted',
      receiverName: receiver.name,
      receiverAvatar: receiver.avatar,
      startTime: new Date()
    });

    const callerSocketId = onlineUsers.get(callerId);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call-accepted', { receiver });
    }
  });

  // 4. Reject Call
  socket.on('call-rejected', async (data) => {
    const { callerId, callId } = data;
    
    if(callId) {
      await CallLog.findByIdAndUpdate(callId, { status: 'rejected', endTime: new Date() });
    }

    const callerSocketId = onlineUsers.get(callerId);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call-rejected');
    }
  });

  // 5. Cancel Call (by Caller before answer)
  socket.on('cancel-call', async (data) => {
    const { receiverId, callId } = data;
    
    if(callId) {
      await CallLog.findByIdAndUpdate(callId, { status: 'canceled', endTime: new Date() });
    }

    const receiverSocketId = onlineUsers.get(receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('call-cancelled');
    }
  });

  // 6. WebRTC Signaling (Offer, Answer, ICE)
  socket.on('webrtc-offer', (data) => {
    const { target, offer } = data; // target is receiverId
    const targetSocket = onlineUsers.get(target);
    if (targetSocket) io.to(targetSocket).emit('webrtc-offer', { offer, sender: data.sender });
  });

  socket.on('webrtc-answer', (data) => {
    const { target, answer } = data; // target is callerId
    const targetSocket = onlineUsers.get(target);
    if (targetSocket) io.to(targetSocket).emit('webrtc-answer', { answer });
  });

  socket.on('ice-candidate', (data) => {
    const { target, candidate } = data;
    const targetSocket = onlineUsers.get(target);
    if (targetSocket) io.to(targetSocket).emit('ice-candidate', { candidate });
  });

  // 7. End Call (After active)
  socket.on('end-call', async (data) => {
    const { targetId, callId } = data;
    
    if (callId) {
      await CallLog.findByIdAndUpdate(callId, { endTime: new Date() });
    }

    const targetSocket = onlineUsers.get(targetId);
    if (targetSocket) {
      io.to(targetSocket).emit('end-call');
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`Socket Disconnected: ${socket.id}`);
    // Remove user from online map
    for (let [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        onlineUsers.delete(userId);
        io.emit('online-users', Array.from(onlineUsers.keys()));
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Backend running on port ${PORT}`));