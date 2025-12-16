const { ClerkExpressRequireAuth } = require('@clerk/clerk-sdk-node');

// Strictly verify the session token
const requireAuth = ClerkExpressRequireAuth({
  onError: (err, req, res) => {
    console.error("Auth Error:", err);
    res.status(401).json({ error: "Unauthenticated" });
  }
});

module.exports = { requireAuth };