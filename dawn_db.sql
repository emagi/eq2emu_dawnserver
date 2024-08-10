create database eq2dawn_web;
use eq2dawn_web;
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(128) NOT NULL,
    salt VARCHAR(32) NOT NULL,
    role ENUM('admin', 'moderator', 'user') NOT NULL DEFAULT 'user'
);