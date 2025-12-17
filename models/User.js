const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  clerkId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String },
  image: { type: String },
  friends: [{ type: String }], // Array of Clerk IDs
  friendRequests: [{
    from: { type: String }, // Clerk ID
    status: { type: String, default: 'pending' } // pending, accepted
  }]
});

module.exports = mongoose.model('User', UserSchema);