const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const env = require('./src/config/env');
const { User } = require('./src/models');

async function createTestUser() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(env.mongodbUri);
    console.log('Connected!');

    const email = 'kazimabbasbhatti110@gmail.com';
    const password = '12345678';

    // Check if user exists
    let user = await User.findOne({ email, agency_id: null }).select('+password_hash');
    
    if (user) {
      console.log('User already exists. Resetting password...');
      await user.setPassword(password);
      await user.save();
      console.log('✓ Password reset successfully');
    } else {
      console.log('Creating new user...');
      // Create new user
      const salt = await bcrypt.genSalt(12);
      const password_hash = await bcrypt.hash(password, salt);
      
      user = await User.create({
        email,
        name: 'Test User',
        role: 'admin',
        agency_id: null,
        password_hash,
        email_verified: true,
        is_active: true,
      });
      console.log('✓ Test user created');
    }

    console.log('\nTest User Ready:');
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

createTestUser();
