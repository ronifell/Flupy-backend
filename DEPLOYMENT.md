# VPS Deployment Guide for Windows

## 📋 Overview

This guide will help you deploy your backend to a VPS (Virtual Private Server). Your VPS is a Linux server, so you'll need to connect to it from your Windows computer.

**Important:** Commands are executed in different places:
- **🖥️ WINDOWS** = Run on your Windows computer (PowerShell or Command Prompt)
- **🌐 VPS** = Run on your VPS server (after SSH connection)

---

## 🔧 Prerequisites - Install Tools on Windows

### Option 1: Use Windows Terminal / PowerShell (Built-in)

Windows 10/11 comes with SSH client. Open **PowerShell** or **Command Prompt**:
- Press `Win + X` and select "Windows PowerShell" or "Terminal"
- Or search for "PowerShell" in Start menu

### Option 2: Use PuTTY (Alternative SSH Client)

1. Download PuTTY: https://www.putty.org/
2. Install it
3. Use PuTTY to connect to your VPS

### Option 3: Use WinSCP (For File Transfer)

1. Download WinSCP: https://winscp.net/
2. Install it
3. Use WinSCP to upload files to your VPS

---

## 📦 Step 1: Prepare Your VPS (First Time Setup)

**🌐 VPS:** Connect to your VPS first. You need:
- Your VPS IP address (e.g., `123.45.67.89`)
- Your VPS username (usually `root` or a user you created)
- Your VPS password or SSH key

### Connect via SSH from Windows:

**🖥️ WINDOWS (PowerShell):**
```powershell
ssh username@your-vps-ip
# Example: ssh root@123.45.67.89
```

**OR using PuTTY:**
1. Open PuTTY
2. Enter your VPS IP address
3. Click "Open"
4. Enter username and password when prompted

### Install Required Software on VPS:

**🌐 VPS:** Once connected, run these commands:

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install Node.js (v18 or higher)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Verify Node.js installation
node --version
npm --version

# Install PM2 (Process Manager)
sudo npm install -g pm2

# Install MySQL
sudo apt install mysql-server -y

# Secure MySQL installation
sudo mysql_secure_installation
# Follow prompts: Set root password, remove anonymous users, etc.

# Install Nginx (Web Server / Reverse Proxy)
sudo apt install nginx -y

# Install Certbot (for SSL certificates)
sudo apt install certbot python3-certbot-nginx -y
```

---

## 📤 Step 2: Upload Your Backend Code to VPS

You have several options:

### Option A: Using SCP (Built into Windows 10/11)

**🖥️ WINDOWS (PowerShell):** Navigate to your project root directory first:

```powershell
# Navigate to your project folder
cd "E:\E disk\Ronifell Data\My projects\Service app"

# Upload backend folder to VPS
scp -r backend username@your-vps-ip:/home/username/flupy-backend
# Example: scp -r backend root@123.45.67.89:/root/flupy-backend
```

**Note:** Replace:
- `username` with your VPS username
- `your-vps-ip` with your VPS IP address
- `/home/username/flupy-backend` with your desired path on VPS

### Option B: Using WinSCP (Easier for Windows)

1. **🖥️ WINDOWS:** Open WinSCP
2. Create new connection:
   - **Host name:** Your VPS IP
   - **User name:** Your VPS username
   - **Password:** Your VPS password
   - Click "Login"
3. Navigate to `/home/username/` (or `/root/` if using root)
4. Create folder `flupy-backend`
5. Drag and drop your `backend` folder from Windows to VPS

### Option C: Using Git (If your code is in a repository)

**🌐 VPS:**
```bash
cd /home/username
git clone your-repository-url flupy-backend
cd flupy-backend
```

---

## ⚙️ Step 3: Set Up Database on VPS

> **⚠️ IMPORTANT:** If you already have a database set up on your VPS (and have tested it locally), you can **SKIP this entire step** and go directly to Step 4. Just make sure to use your existing database credentials in the `.env` file.

**🌐 VPS:** If you need to create a new database, connect to MySQL:

```bash
# Login to MySQL
sudo mysql -u root -p
# Enter your MySQL root password when prompted
```

**🌐 VPS (Inside MySQL):** Run these SQL commands:

```sql
-- Create database
CREATE DATABASE flupy_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create user (replace 'your_secure_password' with a strong password)
CREATE USER 'flupy_user'@'localhost' IDENTIFIED BY 'your_secure_password';

-- Grant privileges
GRANT ALL PRIVILEGES ON flupy_db.* TO 'flupy_user'@'localhost';

-- Apply changes
FLUSH PRIVILEGES;

-- Exit MySQL
EXIT;
```

**🌐 VPS:** Import database schema (only if creating a new database):

```bash
cd /home/username/flupy-backend
mysql -u flupy_user -p flupy_db < database/schema.sql
# Enter the password you set for flupy_user
```

**Note:** If you already have your database set up and populated (from local testing), you can skip the schema import. Your existing database should already have all the necessary tables.

---

## 🔐 Step 4: Configure Environment Variables

**🌐 VPS:** Create and edit the `.env` file:

```bash
cd /home/username/flupy-backend

# Copy example file
cp env.example .env

# Edit the .env file (using nano editor)
nano .env
```

**🌐 VPS:** In the nano editor, update these values:

```env
# Server
PORT=3000
NODE_ENV=production
HOST=0.0.0.0
DOMAIN=your-vps-domain.com  # Replace with your actual domain or IP

# CORS - Replace with your actual domain
ALLOWED_ORIGINS=https://your-vps-domain.com,https://www.your-vps-domain.com

# Database - Use your EXISTING database credentials (the ones you used for local testing)
# If database is on the same VPS, use 'localhost'. If connecting remotely, use your VPS IP.
DB_HOST=localhost  # Use 'localhost' if DB is on same VPS, or your VPS IP if connecting remotely
DB_PORT=3306
DB_USER=your_existing_db_user  # The database user you already created
DB_PASSWORD=your_existing_db_password  # The password for your existing database user
DB_NAME=your_existing_db_name  # The database name you already created

# JWT - Generate a strong random secret
JWT_SECRET=your_very_long_random_secret_key_here
JWT_EXPIRES_IN=7d

# Stripe (Production keys)
STRIPE_SECRET_KEY=sk_live_your_production_stripe_key
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
STRIPE_MONTHLY_PRICE_ID=price_your_monthly_price_id

# Firebase
FIREBASE_PROJECT_ID=your_firebase_project_id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour\nPrivate\nKey\nHere\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=your_firebase_client_email

# File Uploads
UPLOAD_DIR=uploads
MAX_FILE_SIZE=10485760

# AI Assistant
AI_API_KEY=your_openai_api_key
AI_MODEL=gpt-4
```

**To save in nano:**
- Press `Ctrl + O` (save)
- Press `Enter` (confirm filename)
- Press `Ctrl + X` (exit)

---

## 📥 Step 5: Install Dependencies and Prepare

**🌐 VPS:**

```bash
cd /home/username/flupy-backend

# Install Node.js dependencies
npm install --production

# Create logs directory
mkdir logs

# Verify .env file exists
ls -la .env
```

---

## 🚀 Step 6: Start Your Application with PM2

**🌐 VPS:**

```bash
cd /home/username/flupy-backend

# Start the application
pm2 start ecosystem.config.js

# Check status
pm2 status

# View logs
pm2 logs flupy-backend

# Save PM2 configuration (so it restarts on server reboot)
pm2 save

# Set up PM2 to start on boot
pm2 startup
# Follow the instructions it gives you (usually copy and run a sudo command)
```

**Expected output:** You should see your app running. Test it:
```bash
curl http://localhost:3000/api/health
```

---

## 🌐 Step 7: Configure Nginx (Reverse Proxy)

**🌐 VPS:** Create Nginx configuration file:

```bash
sudo nano /etc/nginx/sites-available/flupy-backend
```

**🌐 VPS:** Paste this configuration (replace `your-vps-domain.com` with your domain or IP):

```nginx
server {
    listen 80;
    server_name your-vps-domain.com www.your-vps-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    location /socket.io/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    client_max_body_size 10M;
}
```

**Save:** `Ctrl + O`, `Enter`, `Ctrl + X`

**🌐 VPS:** Enable the site and restart Nginx:

```bash
# Create symbolic link
sudo ln -s /etc/nginx/sites-available/flupy-backend /etc/nginx/sites-enabled/

# Remove default site (optional)
sudo rm /etc/nginx/sites-enabled/default

# Test Nginx configuration
sudo nginx -t

# If test passes, restart Nginx
sudo systemctl restart nginx

# Check Nginx status
sudo systemctl status nginx
```

---

## 🔒 Step 8: Set Up SSL Certificate (HTTPS)

**🌐 VPS:** If you have a domain name:

```bash
sudo certbot --nginx -d your-vps-domain.com -d www.your-vps-domain.com
```

Follow the prompts:
- Enter your email
- Agree to terms
- Choose whether to redirect HTTP to HTTPS (recommended: Yes)

**Note:** If you don't have a domain, you can skip SSL for now and use HTTP with your IP address.

---

## 🔥 Step 9: Configure Firewall

**🌐 VPS:**

```bash
# Allow SSH (important - don't lock yourself out!)
sudo ufw allow 22/tcp

# Allow HTTP
sudo ufw allow 80/tcp

# Allow HTTPS
sudo ufw allow 443/tcp

# Enable firewall
sudo ufw enable

# Check status
sudo ufw status
```

---

## 📱 Step 10: Update Mobile App Configuration

**🖥️ WINDOWS:** Edit your mobile app config file:

Open: `mobile/src/constants/config.js`

Update these lines:
```javascript
export const API_BASE_URL = 'https://your-vps-domain.com/api';
export const SOCKET_URL = 'https://your-vps-domain.com';
```

**Replace `your-vps-domain.com` with:**
- Your actual domain (if you set up SSL)
- Or your VPS IP address with HTTP (e.g., `http://123.45.67.89`)

---

## ✅ Step 11: Test Your Deployment

**🖥️ WINDOWS:** Open a web browser and test:

1. **Health Check:**
   - `http://your-vps-ip/api/health` or `https://your-domain/api/health`
   - Should return: `{"status":"ok","timestamp":"..."}`

2. **Test from Mobile App:**
   - Rebuild your mobile app
   - Try logging in or making an API call

**🌐 VPS:** Check logs if something doesn't work:

```bash
# PM2 logs
pm2 logs flupy-backend

# Nginx logs
sudo tail -f /var/log/nginx/error.log
```

---

## 🛠️ Useful Commands Reference

### PM2 Commands (🌐 VPS):

```bash
pm2 status                    # Check app status
pm2 logs flupy-backend        # View logs
pm2 logs flupy-backend --lines 100  # Last 100 lines
pm2 restart flupy-backend     # Restart app
pm2 stop flupy-backend        # Stop app
pm2 start flupy-backend       # Start app
pm2 monit                     # Monitor resources
pm2 delete flupy-backend      # Remove from PM2
```

### Nginx Commands (🌐 VPS):

```bash
sudo systemctl status nginx   # Check status
sudo systemctl start nginx    # Start
sudo systemctl stop nginx     # Stop
sudo systemctl restart nginx  # Restart
sudo nginx -t                 # Test configuration
```

### MySQL Commands (🌐 VPS):

```bash
sudo systemctl status mysql   # Check status
sudo systemctl restart mysql  # Restart
mysql -u flupy_user -p flupy_db  # Connect to database
```

### File Operations (🌐 VPS):

```bash
cd /home/username/flupy-backend  # Navigate to app directory
ls -la                           # List files
nano filename                    # Edit file
cat filename                     # View file
tail -f logs/out.log             # Watch log file
```

---

## 🐛 Troubleshooting

### App won't start:
```bash
# Check PM2 logs
pm2 logs flupy-backend

# Check if port is in use
sudo netstat -tulpn | grep 3000

# Restart PM2
pm2 restart flupy-backend
```

### Database connection error:
```bash
# Test MySQL connection
mysql -u flupy_user -p flupy_db

# Check MySQL is running
sudo systemctl status mysql
```

### Nginx 502 Bad Gateway:
```bash
# Check if app is running
pm2 status

# Check Nginx error logs
sudo tail -f /var/log/nginx/error.log
```

### Can't access from browser:
```bash
# Check firewall
sudo ufw status

# Check if port is open
sudo netstat -tulpn | grep 80
```

---

## 📝 Quick Reference: Where to Run Commands

| Task | Where to Run | Tool |
|------|--------------|------|
| Upload files | 🖥️ Windows PowerShell | `scp` or WinSCP |
| Install software | 🌐 VPS (via SSH) | SSH terminal |
| Configure app | 🌐 VPS (via SSH) | SSH terminal |
| Edit mobile config | 🖥️ Windows | Your code editor |
| Test API | 🖥️ Windows Browser | Web browser |

---

## 🎉 You're Done!

Your backend should now be running on your VPS. Remember to:
- Keep your `.env` file secure (never commit it to Git)
- Regularly update your VPS packages
- Monitor your application logs
- Set up automated backups for your database
