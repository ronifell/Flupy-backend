# Deployment Checklist

Use this checklist to track your deployment progress.

## Prerequisites
- [ ] VPS IP address: `_________________`
- [ ] VPS username: `_________________`
- [ ] VPS password/SSH key ready
- [ ] Domain name (optional): `_________________`

## Step 1: Connect to VPS
- [ ] Opened PowerShell/Terminal on Windows
- [ ] Successfully connected via SSH: `ssh username@vps-ip`
- [ ] Can see VPS command prompt

## Step 2: Install Software on VPS
- [ ] Updated system: `sudo apt update && sudo apt upgrade -y`
- [ ] Installed Node.js: `curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -`
- [ ] Verified Node.js: `node --version` (should show v18+)
- [ ] Installed PM2: `sudo npm install -g pm2`
- [ ] Installed MySQL: `sudo apt install mysql-server -y`
- [ ] Secured MySQL: `sudo mysql_secure_installation`
- [ ] Installed Nginx: `sudo apt install nginx -y`
- [ ] Installed Certbot: `sudo apt install certbot python3-certbot-nginx -y`

## Step 3: Upload Code
- [ ] Chose upload method (SCP, WinSCP, or Git)
- [ ] Uploaded backend folder to VPS
- [ ] Verified files are on VPS: `ls -la /path/to/flupy-backend`

## Step 4: Database Setup (SKIP if you already have a database)
- [ ] **Skipped** - Using existing database (already tested locally)
- [ ] OR Created database: `CREATE DATABASE flupy_db;`
- [ ] OR Created database user: `CREATE USER 'flupy_user'@'localhost';`
- [ ] OR Granted privileges: `GRANT ALL PRIVILEGES ON flupy_db.* TO 'flupy_user'@'localhost';`
- [ ] OR Imported schema: `mysql -u flupy_user -p flupy_db < database/schema.sql`

## Step 5: Environment Configuration
- [ ] Created `.env` file: `cp env.example .env`
- [ ] Updated `DOMAIN` in `.env`
- [ ] Updated `ALLOWED_ORIGINS` in `.env`
- [ ] Updated database credentials in `.env` (using existing database credentials from local testing)
- [ ] Updated `JWT_SECRET` in `.env` (strong random key)
- [ ] Updated Stripe keys in `.env` (production keys)
- [ ] Updated Firebase credentials in `.env`
- [ ] Updated AI API key in `.env`

## Step 6: Install Dependencies
- [ ] Ran `npm install --production`
- [ ] Created logs directory: `mkdir logs`
- [ ] Verified `.env` file exists: `ls -la .env`

## Step 7: Start Application
- [ ] Started with PM2: `pm2 start ecosystem.config.js`
- [ ] Checked status: `pm2 status` (should show "online")
- [ ] Saved PM2 config: `pm2 save`
- [ ] Set up auto-start: `pm2 startup` (followed instructions)
- [ ] Tested health endpoint: `curl http://localhost:3000/api/health`

## Step 8: Nginx Configuration
- [ ] Created config file: `sudo nano /etc/nginx/sites-available/flupy-backend`
- [ ] Pasted Nginx configuration
- [ ] Enabled site: `sudo ln -s /etc/nginx/sites-available/flupy-backend /etc/nginx/sites-enabled/`
- [ ] Tested config: `sudo nginx -t` (should say "syntax is ok")
- [ ] Restarted Nginx: `sudo systemctl restart nginx`
- [ ] Checked Nginx status: `sudo systemctl status nginx`

## Step 9: SSL Certificate (If using domain)
- [ ] Ran Certbot: `sudo certbot --nginx -d your-domain.com`
- [ ] Verified HTTPS works: `https://your-domain.com/api/health`

## Step 10: Firewall
- [ ] Allowed SSH: `sudo ufw allow 22/tcp`
- [ ] Allowed HTTP: `sudo ufw allow 80/tcp`
- [ ] Allowed HTTPS: `sudo ufw allow 443/tcp`
- [ ] Enabled firewall: `sudo ufw enable`
- [ ] Checked status: `sudo ufw status`

## Step 11: Mobile App Update
- [ ] Updated `mobile/src/constants/config.js`
- [ ] Changed `API_BASE_URL` to VPS URL
- [ ] Changed `SOCKET_URL` to VPS URL
- [ ] Rebuilt mobile app

## Step 12: Testing
- [ ] Health check works: `http://your-vps/api/health`
- [ ] Can access API from browser
- [ ] Mobile app can connect to API
- [ ] Socket.IO connection works
- [ ] File uploads work
- [ ] Database operations work

## Notes
```
Write any important notes here:
- VPS IP: 
- Domain: 
- Database password: (keep secure!)
- Important paths:
```
