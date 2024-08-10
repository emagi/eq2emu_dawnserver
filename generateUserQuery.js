const crypto = require('crypto');

const generateSalt = () => {
  return crypto.randomBytes(16).toString('hex');
};

const hashPassword = (password, salt) => {
  const hash = crypto.createHmac('sha512', salt);
  hash.update(password);
  return hash.digest('hex');
};

// Replace these with the actual username and password you want to insert
const username = 'newuser';
const password = 'newpassword';
const role = 'user'; // or 'admin' or 'moderator'

const salt = generateSalt();
const hashedPassword = hashPassword(password, salt);

console.log('INSERT INTO users (username, password, salt, role) VALUES (');
console.log(`'${username}',`);
console.log(`'${hashedPassword}',`);
console.log(`'${salt}',`);
console.log(`'${role}'`);
console.log(');');
