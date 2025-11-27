# 🚀 START HERE - How to Run the Dashboard

## ⚠️ IMPORTANT: Do NOT Double-Click index.html!

This won't work due to browser security (CORS policy).

---

## ✅ **Correct Way to Run:**

### **Step 1: Open Terminal**
```bash
# On Mac: Cmd+Space, type "Terminal", press Enter
# On Windows: Win+R, type "cmd", press Enter
```

### **Step 2: Navigate to Project**
```bash
cd /Users/bballi/Documents/Repos/snapshot_tradingview
```

### **Step 3: Start the Server**
```bash
npm start
```

You should see:
```
╔════════════════════════════════════════════╗
║   Snapshot TradingView Server Running     ║
╚════════════════════════════════════════════╝

🚀 Server: http://localhost:3000
📊 Dashboard: http://localhost:3000/
✨ Ready to analyze crypto markets!
```

### **Step 4: Open Your Browser**
Go to:
```
http://localhost:3000
```

**NOT:** 
- ❌ file:///Users/bballi/Documents/...
- ❌ Double-clicking index.html
- ❌ Opening index.html in browser

---

## 🎯 **Quick Access Commands**

### **Start Server:**
```bash
cd /Users/bballi/Documents/Repos/snapshot_tradingview
npm start
```

### **Open in Browser Automatically:**
```bash
open http://localhost:3000
```

Or manually navigate to: **http://localhost:3000**

---

## 🔧 **If Server is Already Running**

If you get "Port 3000 already in use":

```bash
# The server is probably already running!
# Just open: http://localhost:3000
```

Or restart it:
```bash
pkill -f "node server.js"
npm start
```

---

## ❓ **Why Does This Matter?**

**CORS (Cross-Origin Resource Sharing)** is a browser security feature that:
- ✅ Allows: http://localhost:3000 → http://localhost:3000/api
- ❌ Blocks: file:///path/to/file.html → http://localhost:3000/api

When you open `index.html` directly, it uses the `file://` protocol, which browsers block for security.

**Solution:** Always access through the web server at `http://localhost:3000`

---

## ✅ **You're Doing It Right When:**

- ✅ URL bar shows: `http://localhost:3000`
- ✅ Terminal shows: "Server Running"
- ✅ Dashboard loads with no errors
- ✅ Console shows no CORS errors

## ❌ **You're Doing It Wrong When:**

- ❌ URL bar shows: `file:///Users/...`
- ❌ Console shows: "CORS policy" errors
- ❌ You double-clicked the HTML file
- ❌ "Failed to fetch" errors appear

---

## 📝 **Checklist:**

1. [ ] Terminal is open
2. [ ] Navigated to project folder (`cd ...`)
3. [ ] Ran `npm start`
4. [ ] See "Server Running" message
5. [ ] Browser is open to `http://localhost:3000` (not file://)
6. [ ] Dashboard loads successfully

---

## 🆘 **Still Having Issues?**

### **Test the Server:**
```bash
curl http://localhost:3000/health
```

Should return: `{"status":"ok",...}`

### **Check What's Running:**
```bash
lsof -i :3000
```

Should show: `node ... (LISTEN)`

### **Full Restart:**
```bash
pkill -f "node server.js"
cd /Users/bballi/Documents/Repos/snapshot_tradingview
npm start
open http://localhost:3000
```

---

## 🎬 **Quick Start (Copy & Paste):**

```bash
cd /Users/bballi/Documents/Repos/snapshot_tradingview && npm start
```

Then open browser to: **http://localhost:3000**

---

**Remember:** The dashboard is a **web application** that needs to run through a web server, not a static HTML file you can double-click!

🚀 **Go to: http://localhost:3000**


