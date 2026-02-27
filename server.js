const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 100 * 1024 * 1024, // 100MB
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const roomDir = path.join(UPLOAD_DIR, req.params.roomId || 'default');
    if (!fs.existsSync(roomDir)) {
      fs.mkdirSync(roomDir, { recursive: true });
    }
    cb(null, roomDir);
  },
  filename: (req, file, cb) => {
    // Preserve original filename with a unique prefix
    const uniquePrefix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, uniquePrefix + '-' + originalName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ============================================================
// In-memory data store
// ============================================================
const rooms = new Map();       // roomId -> { code, name, createdAt, devices, messages }
const codeToRoom = new Map();  // 6-digit code -> roomId

// ============================================================
// Helper functions
// ============================================================
function generateRoomCode() {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (codeToRoom.has(code));
  return code;
}

function getDeviceInfo(socket) {
  const ua = socket.handshake.headers['user-agent'] || '';
  let deviceType = 'desktop';
  let osName = 'Unknown';

  if (/iPhone|iPad/.test(ua)) {
    deviceType = 'phone';
    osName = 'iOS';
  } else if (/Android/.test(ua)) {
    deviceType = 'phone';
    osName = 'Android';
  } else if (/Macintosh/.test(ua)) {
    deviceType = 'desktop';
    osName = 'macOS';
  } else if (/Windows/.test(ua)) {
    deviceType = 'desktop';
    osName = 'Windows';
  } else if (/Linux/.test(ua)) {
    deviceType = 'desktop';
    osName = 'Linux';
  }

  return { deviceType, osName };
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ============================================================
// REST API
// ============================================================

// File upload endpoint
app.post('/api/upload/:roomId', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const roomId = req.params.roomId;
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const fileInfo = {
    id: uuidv4(),
    originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
    filename: req.file.filename,
    size: req.file.size,
    mimetype: req.file.mimetype,
    url: `/uploads/${roomId}/${req.file.filename}`,
    uploadedAt: new Date().toISOString()
  };

  res.json(fileInfo);
});

// QR code endpoint
app.get('/api/qrcode/:code', async (req, res) => {
  try {
    const localIP = getLocalIP();
    const url = `http://${localIP}:${PORT}?join=${req.params.code}`;
    const qr = await QRCode.toDataURL(url, {
      width: 256,
      margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' }
    });
    res.json({ qr, url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Server info
app.get('/api/server-info', (req, res) => {
  const localIP = getLocalIP();
  res.json({ ip: localIP, port: PORT });
});

// ============================================================
// Socket.IO events
// ============================================================
io.on('connection', (socket) => {
  console.log(`[连接] 新设备连接: ${socket.id}`);
  let currentRoom = null;
  let deviceName = null;

  // Create a new room
  socket.on('create-room', (data, callback) => {
    const roomId = uuidv4();
    const code = generateRoomCode();
    const { osName, deviceType } = getDeviceInfo(socket);
    deviceName = data.deviceName || `${osName} 设备`;

    const room = {
      id: roomId,
      code,
      name: data.roomName || '我的工作空间',
      createdAt: new Date().toISOString(),
      creatorId: socket.id,
      devices: new Map(),
      messages: []
    };

    room.devices.set(socket.id, {
      id: socket.id,
      name: deviceName,
      os: osName,
      type: deviceType,
      joinedAt: new Date().toISOString(),
      isCreator: true
    });

    rooms.set(roomId, room);
    codeToRoom.set(code, roomId);
    socket.join(roomId);
    currentRoom = roomId;

    console.log(`[房间] 创建房间: ${room.name} (${code})`);

    callback({
      success: true,
      room: {
        id: roomId,
        code,
        name: room.name,
        devices: Array.from(room.devices.values()),
        messages: room.messages
      }
    });

    // Add system message
    const sysMsg = {
      id: uuidv4(),
      type: 'system',
      content: `${deviceName} 创建了工作空间`,
      timestamp: new Date().toISOString()
    };
    room.messages.push(sysMsg);
    io.to(roomId).emit('new-message', sysMsg);
  });

  // Join existing room
  socket.on('join-room', (data, callback) => {
    const code = data.code;
    const roomId = codeToRoom.get(code);

    if (!roomId || !rooms.has(roomId)) {
      return callback({ success: false, error: '房间不存在，请检查邀请码' });
    }

    const room = rooms.get(roomId);
    const { osName, deviceType } = getDeviceInfo(socket);
    deviceName = data.deviceName || `${osName} 设备`;

    // Check if device name conflicts
    const existingNames = Array.from(room.devices.values()).map(d => d.name);
    if (existingNames.includes(deviceName)) {
      deviceName = `${deviceName} (${room.devices.size + 1})`;
    }

    room.devices.set(socket.id, {
      id: socket.id,
      name: deviceName,
      os: osName,
      type: deviceType,
      joinedAt: new Date().toISOString(),
      isCreator: false
    });

    socket.join(roomId);
    currentRoom = roomId;

    console.log(`[加入] ${deviceName} 加入房间: ${room.name}`);

    callback({
      success: true,
      room: {
        id: roomId,
        code: room.code,
        name: room.name,
        devices: Array.from(room.devices.values()),
        messages: room.messages
      }
    });

    // Notify others
    const sysMsg = {
      id: uuidv4(),
      type: 'system',
      content: `${deviceName} 加入了工作空间`,
      timestamp: new Date().toISOString()
    };
    room.messages.push(sysMsg);
    io.to(roomId).emit('new-message', sysMsg);
    io.to(roomId).emit('device-update', Array.from(room.devices.values()));
  });

  // Send text message
  socket.on('send-text', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const msg = {
      id: uuidv4(),
      type: 'text',
      content: data.content,
      sender: deviceName,
      senderId: socket.id,
      timestamp: new Date().toISOString()
    };

    room.messages.push(msg);
    io.to(currentRoom).emit('new-message', msg);
    console.log(`[消息] ${deviceName}: ${data.content.substring(0, 50)}...`);
  });

  // Send file message (metadata after upload)
  socket.on('send-file', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const msg = {
      id: uuidv4(),
      type: 'file',
      file: {
        originalName: data.originalName,
        filename: data.filename,
        size: data.size,
        mimetype: data.mimetype,
        url: data.url
      },
      sender: deviceName,
      senderId: socket.id,
      timestamp: new Date().toISOString()
    };

    room.messages.push(msg);
    io.to(currentRoom).emit('new-message', msg);
    console.log(`[文件] ${deviceName} 分享了文件: ${data.originalName}`);
  });

  // Send clipboard content
  socket.on('send-clipboard', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const msg = {
      id: uuidv4(),
      type: 'clipboard',
      content: data.content,
      sender: deviceName,
      senderId: socket.id,
      timestamp: new Date().toISOString()
    };

    room.messages.push(msg);
    io.to(currentRoom).emit('new-message', msg);
    console.log(`[剪贴板] ${deviceName} 同步了剪贴板内容`);
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`[断开] 设备断开: ${socket.id}`);
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.devices.delete(socket.id);

        const sysMsg = {
          id: uuidv4(),
          type: 'system',
          content: `${deviceName || '未知设备'} 离开了工作空间`,
          timestamp: new Date().toISOString()
        };
        room.messages.push(sysMsg);
        io.to(currentRoom).emit('new-message', sysMsg);
        io.to(currentRoom).emit('device-update', Array.from(room.devices.values()));

        // Clean up empty rooms after a delay
        if (room.devices.size === 0) {
          setTimeout(() => {
            if (room.devices.size === 0) {
              codeToRoom.delete(room.code);
              rooms.delete(currentRoom);
              // Clean up uploaded files
              const roomDir = path.join(UPLOAD_DIR, currentRoom);
              if (fs.existsSync(roomDir)) {
                fs.rmSync(roomDir, { recursive: true, force: true });
              }
              console.log(`[清理] 空房间已删除: ${room.name}`);
            }
          }, 60000); // 1 minute grace period
        }
      }
    }
  });
});

// ============================================================
// Start server
// ============================================================
server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║                                          ║');
  console.log('  ║         🔗 LinkRoom 已启动               ║');
  console.log('  ║         跨设备实时共享工作空间            ║');
  console.log('  ║                                          ║');
  console.log(`  ║  本机访问: http://localhost:${PORT}         ║`);
  console.log(`  ║  局域网:   http://${localIP}:${PORT}   ║`);
  console.log('  ║                                          ║');
  console.log('  ║  同一网络下的设备可通过局域网地址访问    ║');
  console.log('  ║                                          ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});
