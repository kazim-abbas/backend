const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const env = require('./src/config/env');
const { User } = require('./src/models');

async function setupAdmin() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(env.mongodbUri);
    console.log('Connected!');

    const email = 'kazim@teamaudate.com';
    const password = 'Kazim/110';

    // Check if user exists
    let user = await User.findOne({ email, agency_id: null }).select('+password_hash');
    
    if (user) {
      console.log('User exists. Resetting password...');
      await user.setPassword(password);
      user.is_active = true;
      user.email_verified = true;
      await user.save();
      console.log('✓ Password reset successfully');
    } else {
      console.log('Creating new admin user...');
      // Create new user
      const salt = await bcrypt.genSalt(12);
      const password_hash = await bcrypt.hash(password, salt);
      
      user = await User.create({
        email,
        name: 'Admin User',
        role: 'admin',
        agency_id: null,
        password_hash,
        email_verified: true,
        is_active: true,
      });
      console.log('✓ Admin user created');
    }

    console.log('\nAdmin Account Ready:');
    console.log('  Email:', email);
    console.log('  Password:', password);
    console.log('  Role: admin');

    await mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

setupAdmin();
