const mongoose = require('mongoose');
const { connectDatabase } = require('./src/config/database');
const { User } = require('./src/models');

(async () => {
  try {
    await connectDatabase();
    const user = await User.findOne({ email: 'kazim@teamaudate.com' }).select('+password_hash');
    if (user) {
      console.log('\n✓ User found:');
      console.log('  Email:', user.email);
      console.log('  Name:', user.name);
      console.log('  Role:', user.role);
      console.log('  Is Active:', user.is_active);
      console.log('  Email Verified:', user.email_verified);
      console.log('  Agency ID:', user.agency_id);
      console.log('  Password Hash exists:', !!user.password_hash);
      console.log('  Password Hash length:', user.password_hash ? user.password_hash.length : 0);
      
      // Test password verification
      const testPass = await user.verifyPassword('Kazim/110');
      console.log('  Password "Kazim/110" matches:', testPass);
    } else {
      console.log('\n✗ User not found in database');
      console.log('Looking for: kazim@teamaudate.com');
    }
    process.exit(0);
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    process.exit(1);
  }
})();
