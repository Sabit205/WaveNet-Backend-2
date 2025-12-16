const mongoose = require('mongoose');

const CallLogSchema = new mongoose.Schema({
  callerId: { type: String, required: true },
  callerName: { type: String, required: true }, // Store name for simpler history
  callerAvatar: { type: String },
  receiverId: { type: String, required: true },
  receiverName: { type: String, required: true },
  receiverAvatar: { type: String },
  callType: { type: String, enum: ['audio', 'video'], required: true },
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date },
  status: { 
    type: String, 
    enum: ['accepted', 'rejected', 'missed', 'canceled'], 
    default: 'missed' 
  }
});

module.exports = mongoose.model('CallLog', CallLogSchema);