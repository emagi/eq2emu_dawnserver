const crypto = require('crypto');

const generateSalt = () => {
  return crypto.randomBytes(16).toString('hex');
};

const hashPassword = (password, salt) => {
  const hash = crypto.createHmac('sha512', salt);
  hash.update(password);
  return hash.digest('hex');
};

var argv = require('minimist')(process.argv.slice(2));

var username = 'admin';
if("username" in argv) {
	username = argv["username"];
}

var password = 'abcd!';
if("password" in argv) {
	password = argv["password"];
}

var role = 'user';
if("role" in argv) {
	role = argv["role"];
}

const salt = generateSalt();
const hashedPassword = hashPassword(password, salt);

console.log(`INSERT INTO users (username, password, salt, role) VALUES ('${username}','${hashedPassword}','${salt}','${role}') ON DUPLICATE KEY UPDATE password='${hashedPassword}', salt='${salt}';`);
