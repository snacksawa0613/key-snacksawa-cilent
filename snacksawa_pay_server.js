// snacksawa_pay_server.js - 完整购买支付系统
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔐 配置
const CONFIG = {
    adminPassword: "snacksawa",
    prices: {
        DAY: { name: "日卡", price: 15, days: 1, color: "#ff6b6b" },
        WEEK: { name: "周卡", price: 77, days: 7, color: "#4ecdc4" },
        MONTH: { name: "月卡", price: 129, days: 30, color: "#45b7d1" },
        YEAR: { name: "年卡", price: 256, days: 365, color: "#96ceb4" },
        LIFETIME: { name: "永久卡", price: 532, days: 9999, color: "#feca57" }
    },
    paymentMethods: [
        { id: "alipay", name: "支付宝", icon: "💰", color: "#1296db" },
        { id: "wechat", name: "微信支付", icon: "💬", color: "#07c160" },
        { id: "qqpay", name: "QQ支付", icon: "🐧", color: "#12b7f5" },
        { id: "bank", name: "银行卡", icon: "🏦", color: "#f4ea2a" }
    ]
};

// 📊 内存数据库
let database = {
    licenses: {},
    orders: {},
    payments: {},
    users: {},
    stats: {
        totalSales: 0,
        todaySales: 0,
        totalOrders: 0,
        todayOrders: 0,
        totalLicenses: 0,
        revenue: {
            DAY: 0,
            WEEK: 0,
            MONTH: 0,
            YEAR: 0,
            LIFETIME: 0
        },
        lastReset: new Date().toLocaleDateString()
    },
    settings: {
        maxActivations: 3,
        hwidLock: true,
        siteTitle: "零食客户端 - 官方商店",
        contactQQ: "123456789",
        contactEmail: "support@snacksawa.com",
        notification: "🎉 购买成功后自动发货，请查看邮箱或联系客服"
    }
};

// 🔑 生成订单号
function generateOrderId() {
    const date = new Date();
    const dateStr = date.getFullYear().toString().substr(2) + 
                   (date.getMonth() + 1).toString().padStart(2, '0') + 
                   date.getDate().toString().padStart(2, '0');
    const random = Math.random().toString(36).substr(2, 6).toUpperCase();
    return `SNK${dateStr}${random}`;
}

// 🎟️ 生成许可证
function generateLicenseKey(type = "MONTH") {
    const prefix = {
        "DAY": "SNK-D",
        "WEEK": "SNK-W", 
        "MONTH": "SNK-M",
        "YEAR": "SNK-Y",
        "LIFETIME": "SNK-L"
    }[type] || "SNK-M";
    
    const random = crypto.randomBytes(8).toString('hex').toUpperCase();
    const checksum = crypto.createHash('md5').update(random).digest('hex').substring(0, 6).toUpperCase();
    return `${prefix}-${random}-${checksum}`;
}

// 📅 计算到期时间
function calculateExpiry(type, customDays = null) {
    const now = new Date();
    const expiry = new Date(now);
    
    if (type === "LIFETIME") {
        expiry.setFullYear(now.getFullYear() + 100);
        return expiry.toISOString();
    }
    
    const days = customDays || CONFIG.prices[type]?.days || 30;
    expiry.setDate(now.getDate() + days);
    return expiry.toISOString();
}

// ✨ 创建许可证
function createLicense(type, orderId, email = "", customDays = null) {
    const key = generateLicenseKey(type);
    const now = new Date().toISOString();
    const expiry = calculateExpiry(type, customDays);
    const price = CONFIG.prices[type]?.price || 0;
    
    const license = {
        key: key,
        type: type,
        status: "INACTIVE",
        created: now,
        expiry: expiry,
        orderId: orderId,
        email: email,
        price: price,
        activations: 0,
        maxActivations: database.settings.maxActivations,
        hwid: [],
        lastUsed: null
    };
    
    database.licenses[key] = license;
    database.stats.totalLicenses++;
    
    log("LICENSE_CREATED", key, { type, orderId, price });
    return license;
}

// 🛒 创建订单
function createOrder(type, email, paymentMethod, customInfo = {}) {
    const orderId = generateOrderId();
    const now = new Date().toISOString();
    const price = CONFIG.prices[type]?.price || 0;
    
    const order = {
        id: orderId,
        type: type,
        status: "PENDING", // PENDING, PAID, CANCELLED, REFUNDED
        email: email,
        price: price,
        paymentMethod: paymentMethod,
        created: now,
        paidAt: null,
        licenseKey: null,
        customInfo: customInfo,
        paymentDetails: {
            transactionId: null,
            payer: null,
            amount: price
        }
    };
    
    database.orders[orderId] = order;
    database.stats.totalOrders++;
    
    // 更新今日订单数
    const today = new Date().toLocaleDateString();
    if (database.stats.lastReset !== today) {
        database.stats.todayOrders = 1;
        database.stats.todaySales = 0;
        database.stats.lastReset = today;
    } else {
        database.stats.todayOrders++;
    }
    
    log("ORDER_CREATED", orderId, { type, email, price });
    return order;
}

// 💰 处理支付成功
function processPayment(orderId, paymentData) {
    const order = database.orders[orderId];
    if (!order) return { success: false, error: "订单不存在" };
    
    if (order.status === "PAID") {
        return { success: false, error: "订单已支付" };
    }
    
    // 更新订单状态
    order.status = "PAID";
    order.paidAt = new Date().toISOString();
    order.paymentDetails = {
        ...order.paymentDetails,
        transactionId: paymentData.transactionId || `TRX${Date.now()}`,
        payer: paymentData.payer || order.email,
        paidAmount: paymentData.amount || order.price,
        paidTime: new Date().toISOString()
    };
    
    // 创建许可证
    const license = createLicense(order.type, orderId, order.email);
    order.licenseKey = license.key;
    
    // 更新统计
    database.stats.totalSales += order.price;
    database.stats.todaySales += order.price;
    database.stats.revenue[order.type] = (database.stats.revenue[order.type] || 0) + order.price;
    
    // 保存支付记录
    const paymentId = `PAY${Date.now()}`;
    database.payments[paymentId] = {
        id: paymentId,
        orderId: orderId,
        licenseKey: license.key,
        amount: order.price,
        method: order.paymentMethod,
        time: new Date().toISOString(),
        payer: order.email
    };
    
    log("PAYMENT_SUCCESS", orderId, { 
        licenseKey: license.key, 
        amount: order.price,
        method: order.paymentMethod 
    });
    
    return {
        success: true,
        order: order,
        license: license
    };
}

// 📧 发送邮件（模拟）
function sendLicenseEmail(email, licenseKey, orderDetails) {
    console.log(`📧 发送许可证到: ${email}`);
    console.log(`🔑 许可证: ${licenseKey}`);
    console.log(`💰 订单金额: ${orderDetails.price}元`);
    
    // 实际应该集成邮件服务
    return true;
}

// 📝 日志记录
function log(action, target, data = {}) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        action: action,
        target: target,
        data: data
    };
    
    console.log(`[${logEntry.timestamp}] ${action}: ${target}`, data);
    
    // 保存到数据库
    if (!database.logs) database.logs = [];
    database.logs.push(logEntry);
    if (database.logs.length > 1000) database.logs.shift();
}

// ========== 🛒 购买界面 ==========

// 主页 - 产品展示
app.get('/', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${database.settings.siteTitle}</title>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        <style>
            :root {
                --primary: #3498db;
                --secondary: #2c3e50;
                --success: #2ecc71;
                --warning: #f39c12;
                --danger: #e74c3c;
                --light: #ecf0f1;
                --dark: #2c3e50;
            }
            
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                padding: 20px;
                color: #333;
            }
            
            .container {
                max-width: 1400px;
                margin: 0 auto;
            }
            
            .header {
                background: white;
                border-radius: 15px;
                padding: 30px;
                margin-bottom: 30px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.1);
                text-align: center;
            }
            
            .logo {
                font-size: 36px;
                font-weight: bold;
                color: var(--secondary);
                margin-bottom: 10px;
            }
            
            .logo span {
                color: var(--primary);
            }
            
            .tagline {
                color: #666;
                font-size: 18px;
                margin-bottom: 20px;
            }
            
            .notification {
                background: #fff3cd;
                border: 1px solid #ffeaa7;
                border-radius: 8px;
                padding: 15px;
                margin: 20px auto;
                max-width: 800px;
                color: #856404;
            }
            
            .products-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
                gap: 25px;
                margin-bottom: 40px;
            }
            
            .product-card {
                background: white;
                border-radius: 15px;
                overflow: hidden;
                box-shadow: 0 10px 30px rgba(0,0,0,0.1);
                transition: transform 0.3s, box-shadow 0.3s;
                position: relative;
            }
            
            .product-card:hover {
                transform: translateY(-10px);
                box-shadow: 0 20px 40px rgba(0,0,0,0.15);
            }
            
            .product-badge {
                position: absolute;
                top: 15px;
                right: 15px;
                background: var(--danger);
                color: white;
                padding: 5px 15px;
                border-radius: 20px;
                font-size: 14px;
                font-weight: bold;
            }
            
            .product-header {
                padding: 30px 20px;
                text-align: center;
                color: white;
            }
            
            .product-title {
                font-size: 24px;
                font-weight: bold;
                margin-bottom: 10px;
            }
            
            .product-price {
                font-size: 42px;
                font-weight: bold;
                margin: 20px 0;
            }
            
            .product-price span {
                font-size: 18px;
                color: rgba(255,255,255,0.8);
            }
            
            .product-features {
                padding: 25px;
            }
            
            .feature-item {
                display: flex;
                align-items: center;
                margin: 15px 0;
                color: #555;
            }
            
            .feature-item i {
                color: var(--success);
                margin-right: 10px;
                font-size: 18px;
            }
            
            .buy-button {
                display: block;
                width: calc(100% - 40px);
                margin: 20px;
                padding: 18px;
                background: var(--primary);
                color: white;
                border: none;
                border-radius: 10px;
                font-size: 18px;
                font-weight: bold;
                cursor: pointer;
                transition: background 0.3s;
                text-align: center;
                text-decoration: none;
            }
            
            .buy-button:hover {
                background: #2980b9;
            }
            
            .payment-methods {
                background: white;
                border-radius: 15px;
                padding: 30px;
                margin-top: 40px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            }
            
            .methods-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 20px;
                margin-top: 20px;
            }
            
            .method-card {
                padding: 20px;
                border: 2px solid #eee;
                border-radius: 10px;
                text-align: center;
                transition: border-color 0.3s;
            }
            
            .method-card:hover {
                border-color: var(--primary);
            }
            
            .method-icon {
                font-size: 48px;
                margin-bottom: 15px;
            }
            
            .method-name {
                font-size: 18px;
                font-weight: bold;
                margin: 10px 0;
            }
            
            .footer {
                text-align: center;
                margin-top: 40px;
                padding: 20px;
                color: white;
                font-size: 14px;
            }
            
            .footer a {
                color: white;
                text-decoration: none;
                margin: 0 10px;
            }
            
            .contact-info {
                background: white;
                border-radius: 15px;
                padding: 25px;
                margin-top: 30px;
                text-align: center;
            }
            
            @media (max-width: 768px) {
                .products-grid {
                    grid-template-columns: 1fr;
                }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <!-- 头部 -->
            <div class="header">
                <div class="logo">🍬 零食客户端</div>
                <div class="tagline">🎮 Minecraft 1.20.1 专属增强客户端</div>
                <div class="notification">
                    <i class="fas fa-info-circle"></i> ${database.settings.notification}
                </div>
            </div>
            
            <!-- 产品展示 -->
            <div class="products-grid">
                ${Object.entries(CONFIG.prices).map(([type, info]) => `
                <div class="product-card">
                    ${type === 'LIFETIME' ? '<div class="product-badge">🔥 最受欢迎</div>' : ''}
                    <div class="product-header" style="background: ${info.color};">
                        <div class="product-title">${info.name}</div>
                        <div class="product-price">¥${info.price}<span>元</span></div>
                        <div>有效期: ${info.days === 9999 ? '永久' : info.days + '天'}</div>
                    </div>
                    <div class="product-features">
                        <div class="feature-item">
                            <i class="fas fa-check-circle"></i>
                            <span>完整功能解锁</span>
                        </div>
                        <div class="feature-item">
                            <i class="fas fa-shield-alt"></i>
                            <span>优先技术支持</span>
                        </div>
                        <div class="feature-item">
                            <i class="fas fa-sync-alt"></i>
                            <span>免费更新维护</span>
                        </div>
                        <div class="feature-item">
                            <i class="fas fa-users"></i>
                            <span>官方社区权限</span>
                        </div>
                        <div class="feature-item">
                            <i class="fas fa-mobile-alt"></i>
                            <span>多设备支持</span>
                        </div>
                    </div>
                    <a href="/buy/${type.toLowerCase()}" class="buy-button">
                        立即购买 ¥${info.price}
                    </a>
                </div>
                `).join('')}
            </div>
            
            <!-- 支付方式 -->
            <div class="payment-methods">
                <h2 style="text-align: center; margin-bottom: 20px;">💳 支持支付方式</h2>
                <div class="methods-grid">
                    ${CONFIG.paymentMethods.map(method => `
                    <div class="method-card">
                        <div class="method-icon" style="color: ${method.color};">${method.icon}</div>
                        <div class="method-name">${method.name}</div>
                    </div>
                    `).join('')}
                </div>
            </div>
            
            <!-- 联系信息 -->
            <div class="contact-info">
                <h3>📞 需要帮助？</h3>
                <p style="margin: 15px 0;">
                    <i class="fas fa-qq"></i> QQ: ${database.settings.contactQQ}<br>
                    <i class="fas fa-envelope"></i> 邮箱: ${database.settings.contactEmail}
                </p>
                <p style="color: #666; font-size: 14px;">
                    客服在线时间: 9:00 - 23:00<br>
                    购买后未收到许可证？请联系客服处理
                </p>
            </div>
            
            <!-- 页脚 -->
            <div class="footer">
                <p>© 2024 零食客户端 版权所有</p>
                <p>
                    <a href="/admin" style="color: #ff6b6b;">🔐 管理入口</a> | 
                    <a href="/verify">🎫 验证许可证</a> | 
                    <a href="/orders">📋 订单查询</a>
                </p>
            </div>
        </div>
        
        <script>
            // 简单的访问统计
            console.log('欢迎访问零食客户端商店！');
        </script>
    </body>
    </html>
    `;
    
    res.send(html);
});

// 购买页面
app.get('/buy/:type', (req, res) => {
    const type = req.params.type.toUpperCase();
    const product = CONFIG.prices[type];
    
    if (!product) {
        return res.redirect('/');
    }
    
    const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>购买 ${product.name} - ${database.settings.siteTitle}</title>
        <style>
            body {
                font-family: 'Microsoft YaHei', sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                padding: 20px;
                display: flex;
                justify-content: center;
                align-items: center;
            }
            
            .container {
                background: white;
                border-radius: 20px;
                padding: 40px;
                max-width: 600px;
                width: 100%;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            }
            
            .header {
                text-align: center;
                margin-bottom: 30px;
            }
            
            .product-info {
                background: ${product.color}15;
                border: 2px solid ${product.color};
                border-radius: 15px;
                padding: 25px;
                margin-bottom: 30px;
                text-align: center;
            }
            
            .product-name {
                font-size: 28px;
                font-weight: bold;
                color: ${product.color};
                margin-bottom: 10px;
            }
            
            .product-price {
                font-size: 48px;
                font-weight: bold;
                color: ${product.color};
                margin: 20px 0;
            }
            
            .form-group {
                margin: 20px 0;
            }
            
            label {
                display: block;
                margin-bottom: 8px;
                font-weight: bold;
                color: #555;
            }
            
            input, select {
                width: 100%;
                padding: 15px;
                border: 2px solid #eee;
                border-radius: 10px;
                font-size: 16px;
                transition: border-color 0.3s;
            }
            
            input:focus, select:focus {
                border-color: ${product.color};
                outline: none;
            }
            
            .payment-methods {
                display: grid;
                grid-template-columns: repeat(2, 1fr);
                gap: 15px;
                margin: 20px 0;
            }
            
            .payment-option {
                border: 2px solid #eee;
                border-radius: 10px;
                padding: 15px;
                text-align: center;
                cursor: pointer;
                transition: all 0.3s;
            }
            
            .payment-option:hover {
                border-color: ${product.color};
                background: ${product.color}10;
            }
            
            .payment-option.selected {
                border-color: ${product.color};
                background: ${product.color}15;
            }
            
            .payment-icon {
                font-size: 32px;
                margin-bottom: 10px;
            }
            
            .submit-btn {
                width: 100%;
                padding: 18px;
                background: ${product.color};
                color: white;
                border: none;
                border-radius: 10px;
                font-size: 20px;
                font-weight: bold;
                cursor: pointer;
                transition: background 0.3s;
                margin-top: 30px;
            }
            
            .submit-btn:hover {
                background: ${product.color}dd;
            }
            
            .back-link {
                display: block;
                text-align: center;
                margin-top: 20px;
                color: #666;
                text-decoration: none;
            }
            
            .back-link:hover {
                color: ${product.color};
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🎮 购买许可证</h1>
                <p>填写信息完成购买</p>
            </div>
            
            <div class="product-info">
                <div class="product-name">${product.name}</div>
                <div>有效期: ${product.days === 9999 ? '永久' : product.days + '天'}</div>
                <div class="product-price">¥${product.price}</div>
            </div>
            
            <form id="orderForm" action="/api/create-order" method="POST">
                <input type="hidden" name="type" value="${type}">
                
                <div class="form-group">
                    <label for="email"><i class="fas fa-envelope"></i> 邮箱地址</label>
                    <input type="email" id="email" name="email" required 
                           placeholder="请输入邮箱，许可证将发送到此邮箱">
                </div>
                
                <div class="form-group">
                    <label><i class="fas fa-credit-card"></i> 选择支付方式</label>
                    <div class="payment-methods">
                        ${CONFIG.paymentMethods.map(method => `
                        <label class="payment-option">
                            <input type="radio" name="paymentMethod" value="${method.id}" required 
                                   style="display: none;">
                            <div class="payment-icon" style="color: ${method.color};">${method.icon}</div>
                            <div>${method.name}</div>
                        </label>
                        `).join('')}
                    </div>
                </div>
                
                <div class="form-group">
                    <label for="qq"><i class="fas fa-qq"></i> QQ号码（可选）</label>
                    <input type="text" id="qq" name="qq" placeholder="方便客服联系您">
                </div>
                
                <div class="form-group">
                    <label for="note"><i class="fas fa-edit"></i> 备注（可选）</label>
                    <input type="text" id="note" name="note" placeholder="特殊要求或备注">
                </div>
                
                <button type="submit" class="submit-btn">
                    <i class="fas fa-shopping-cart"></i> 立即支付 ¥${product.price}
                </button>
            </form>
            
            <a href="/" class="back-link">
                <i class="fas fa-arrow-left"></i> 返回产品列表
            </a>
        </div>
        
        <script>
            // 支付方式选择效果
            document.querySelectorAll('.payment-option').forEach(option => {
                option.addEventListener('click', function() {
                    document.querySelectorAll('.payment-option').forEach(o => {
                        o.classList.remove('selected');
                    });
                    this.classList.add('selected');
                    this.querySelector('input').checked = true;
                });
            });
            
            // 表单提交
            document.getElementById('orderForm').addEventListener('submit', async function(e) {
                e.preventDefault();
                
                const formData = new FormData(this);
                const submitBtn = this.querySelector('.submit-btn');
                const originalText = submitBtn.innerHTML;
                
                submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 处理中...';
                submitBtn.disabled = true;
                
                try {
                    const response = await fetch('/api/create-order', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams(formData)
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        // 跳转到支付页面
                        window.location.href = \`/payment/\${data.orderId}\`;
                    } else {
                        alert('创建订单失败: ' + data.error);
                        submitBtn.innerHTML = originalText;
                        submitBtn.disabled = false;
                    }
                } catch (error) {
                    alert('网络错误，请重试');
                    submitBtn.innerHTML = originalText;
                    submitBtn.disabled = false;
                }
            });
        </script>
    </body>
    </html>
    `;
    
    res.send(html);
});

// 支付页面
app.get('/payment/:orderId', (req, res) => {
    const orderId = req.params.orderId;
    const order = database.orders[orderId];
    
    if (!order) {
        return res.redirect('/');
    }
    
    const product = CONFIG.prices[order.type];
    const paymentMethod = CONFIG.paymentMethods.find(m => m.id === order.paymentMethod);
    
    const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>支付订单 - ${database.settings.siteTitle}</title>
        <style>
            body {
                font-family: 'Microsoft YaHei', sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                padding: 20px;
                display: flex;
                justify-content: center;
                align-items: center;
            }
            
            .container {
                background: white;
                border-radius: 20px;
                padding: 40px;
                max-width: 800px;
                width: 100%;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            }
            
            .order-header {
                text-align: center;
                margin-bottom: 30px;
                padding-bottom: 20px;
                border-bottom: 2px solid #eee;
            }
            
            .order-id {
                font-size: 24px;
                font-weight: bold;
                color: ${product.color};
                margin: 10px 0;
            }
            
            .order-status {
                display: inline-block;
                padding: 8px 20px;
                background: ${order.status === 'PAID' ? '#2ecc71' : '#f39c12'};
                color: white;
                border-radius: 20px;
                font-weight: bold;
                margin: 10px 0;
            }
            
            .order-details {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                gap: 20px;
                margin: 30px 0;
            }
            
            .detail-card {
                background: #f8f9fa;
                border-radius: 15px;
                padding: 20px;
                text-align: center;
            }
            
            .detail-label {
                color: #666;
                font-size: 14px;
                margin-bottom: 10px;
            }
            
            .detail-value {
                font-size: 24px;
                font-weight: bold;
                color: #333;
            }
            
            .payment-section {
                background: #f8f9fa;
                border-radius: 15px;
                padding: 30px;
                margin: 30px 0;
                text-align: center;
            }
            
            .payment-method {
                font-size: 32px;
                color: ${paymentMethod.color};
                margin: 20px 0;
            }
            
            .qr-code {
                width: 200px;
                height: 200px;
                background: #f0f0f0;
                border-radius: 10px;
                margin: 20px auto;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 60px;
                color: ${paymentMethod.color};
            }
            
            .payment-amount {
                font-size: 48px;
                font-weight: bold;
                color: #e74c3c;
                margin: 20px 0;
            }
            
            .payment-amount span {
                font-size: 24px;
                color: #666;
            }
            
            .payment-instructions {
                text-align: left;
                background: white;
                border-radius: 10px;
                padding: 20px;
                margin: 20px 0;
                border-left: 4px solid ${paymentMethod.color};
            }
            
            .instruction-item {
                margin: 10px 0;
                padding: 8px 0;
                border-bottom: 1px solid #eee;
            }
            
            .action-buttons {
                display: flex;
                gap: 20px;
                margin-top: 30px;
            }
            
            .action-btn {
                flex: 1;
                padding: 18px;
                border: none;
                border-radius: 10px;
                font-size: 18px;
                font-weight: bold;
                cursor: pointer;
                transition: all 0.3s;
            }
            
            .pay-btn {
                background: ${product.color};
                color: white;
            }
            
            .pay-btn:hover {
                background: ${product.color}dd;
            }
            
            .cancel-btn {
                background: #eee;
                color: #666;
            }
            
            .cancel-btn:hover {
                background: #ddd;
            }
            
            .timer {
                text-align: center;
                margin: 20px 0;
                font-size: 18px;
                color: #e74c3c;
                font-weight: bold;
            }
            
            .license-info {
                background: #d4edda;
                border: 2px solid #c3e6cb;
                border-radius: 15px;
                padding: 25px;
                margin-top: 30px;
                display: none;
            }
            
            .license-key {
                font-family: monospace;
                font-size: 24px;
                background: white;
                padding: 15px;
                border-radius: 10px;
                margin: 15px 0;
                letter-spacing: 2px;
                font-weight: bold;
                color: #155724;
            }
            
            .next-steps {
                margin-top: 30px;
                padding: 20px;
                background: #e3f2fd;
                border-radius: 10px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="order-header">
                <h1>💳 支付订单</h1>
                <div class="order-id">订单号: ${order.id}</div>
                <div class="order-status">
                    ${order.status === 'PAID' ? '✅ 已支付' : '⏳ 待支付'}
                </div>
            </div>
            
            <div class="order-details">
                <div class="detail-card">
                    <div class="detail-label">产品类型</div>
                    <div class="detail-value">${product.name}</div>
                </div>
                <div class="detail-card">
                    <div class="detail-label">支付方式</div>
                    <div class="detail-value">${paymentMethod.name}</div>
                </div>
                <div class="detail-card">
                    <div class="detail-label">邮箱地址</div>
                    <div class="detail-value">${order.email}</div>
                </div>
                <div class="detail-card">
                    <div class="detail-label">创建时间</div>
                    <div class="detail-value">${new Date(order.created).toLocaleString()}</div>
                </div>
            </div>
            
            ${order.status !== 'PAID' ? `
            <div class="payment-section">
                <h2>${paymentMethod.icon} ${paymentMethod.name} 支付</h2>
                
                <div class="qr-code" id="qrCode">
                    ${paymentMethod.icon}
                </div>
                
                <div class="payment-amount">
                    ¥${order.price}<span>元</span>
                </div>
                
                <div class="timer" id="timer">
                    支付剩余时间: <span id="countdown">15:00</span>
                </div>
                
                <div class="payment-instructions">
                    <h3>支付说明:</h3>
                    ${paymentMethod.id === 'alipay' ? `
                    <div class="instruction-item">1. 打开支付宝APP</div>
                    <div class="instruction-item">2. 扫描上方二维码</div>
                    <div class="instruction-item">3. 确认支付金额</div>
                    <div class="instruction-item">4. 输入支付密码完成支付</div>
                    ` : paymentMethod.id === 'wechat' ? `
                    <div class="instruction-item">1. 打开微信APP</div>
                    <div class="instruction-item">2. 扫描上方二维码</div>
                    <div class="instruction-item">3. 确认商户信息</div>
                    <div class="instruction-item">4. 完成支付</div>
                    ` : `
                    <div class="instruction-item">1. 请转账到指定账户</div>
                    <div class="instruction-item">2. 转账时备注订单号</div>
                    <div class="instruction-item">3. 转账后点击"我已支付"</div>
                    <div class="instruction-item">4. 系统自动验证后发货</div>
                    `}
                </div>
                
                <div class="action-buttons">
                    <button class="action-btn cancel-btn" onclick="cancelOrder()">
                        ❌ 取消订单
                    </button>
                    <button class="action-btn pay-btn" onclick="confirmPayment()">
                        ✅ 我已支付
                    </button>
                </div>
            </div>
            ` : ''}
            
            ${order.status === 'PAID' && order.licenseKey ? `
            <div class="license-info" id="licenseInfo">
                <h2>🎉 购买成功！</h2>
                <p>许可证已生成并发送到您的邮箱: <strong>${order.email}</strong></p>
                
                <div class="license-key">
                    ${order.licenseKey}
                </div>
                
                <div class="next-steps">
                    <h3>下一步操作:</h3>
                    <p>1. 复制上方许可证密钥</p>
                    <p>2. 在零食客户端中输入此密钥</p>
                    <p>3. 开始使用所有功能！</p>
                    <p><a href="/verify" style="color: #007bff;">点击这里验证许可证</a></p>
                </div>
            </div>
            ` : ''}
            
            <div style="text-align: center; margin-top: 30px;">
                <a href="/" style="color: #666; text-decoration: none;">
                    <i class="fas fa-home"></i> 返回首页
                </a>
            </div>
        </div>
        
        <script>
            // 倒计时功能
            let timeLeft = 15 * 60; // 15分钟
            
            function updateTimer() {
                const minutes = Math.floor(timeLeft / 60);
                const seconds = timeLeft % 60;
                document.getElementById('countdown').textContent = 
                    \`\${minutes.toString().padStart(2, '0')}:\${seconds.toString().padStart(2, '0')}\`;
                
                if (timeLeft <= 0) {
                    clearInterval(timerInterval);
                    alert('支付超时，订单已取消');
                    window.location.href = '/';
                }
                
                timeLeft--;
            }
            
            ${order.status !== 'PAID' ? `
            const timerInterval = setInterval(updateTimer, 1000);
            updateTimer();
            ` : ''}
            
            // 取消订单
            async function cancelOrder() {
                if (!confirm('确定要取消订单吗？')) return;
                
                try {
                    const response = await fetch('/api/cancel-order/${orderId}', {
                        method: 'POST'
                    });
                    
                    const data = await response.json();
                    if (data.success) {
                        alert('订单已取消');
                        window.location.href = '/';
                    }
                } catch (error) {
                    alert('取消失败，请重试');
                }
            }
            
            // 确认支付
            async function confirmPayment() {
                if (!confirm('确认已完成支付？系统将验证支付信息。')) return;
                
                try {
                    const response = await fetch('/api/confirm-payment/${orderId}', {
                        method: 'POST'
                    });
                    
                    const data = await response.json();
                    if (data.success) {
                        // 显示许可证信息
                        document.getElementById('licenseInfo').style.display = 'block';
                        document.querySelector('.payment-section').style.display = 'none';
                        document.querySelector('.order-status').textContent = '✅ 已支付';
                        document.querySelector('.order-status').style.background = '#2ecc71';
                        
                        // 自动复制许可证
                        navigator.clipboard.writeText(data.license.key);
                        alert('支付成功！许可证已复制到剪贴板。');
                    } else {
                        alert('支付验证失败: ' + data.error);
                    }
                } catch (error) {
                    alert('网络错误，请重试');
                }
            }
            
            ${order.status === 'PAID' ? `
            // 如果已支付，显示许可证信息
            document.getElementById('licenseInfo').style.display = 'block';
            ` : ''}
        </script>
    </body>
    </html>
    `;
    
    res.send(html);
});

// ========== 📋 订单查询页面 ==========
app.get('/orders', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>订单查询 - ${database.settings.siteTitle}</title>
        <style>
            body { font-family: Arial; padding: 20px; background: #f5f5f5; }
            .container { max-width: 1000px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
            .search-box { margin: 20px 0; }
            input, button { padding: 10px; margin: 5px; }
            table { width: 100%; border-collapse: collapse; margin: 20px 0; }
            th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
            .status-paid { color: green; }
            .status-pending { color: orange; }
            .status-cancelled { color: red; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>📋 订单查询</h1>
            <div class="search-box">
                <input type="text" id="orderId" placeholder="输入订单号">
                <input type="text" id="email" placeholder="或输入邮箱">
                <button onclick="searchOrder()">查询订单</button>
            </div>
            <div id="orderResult"></div>
        </div>
        <script>
            async function searchOrder() {
                const orderId = document.getElementById('orderId').value;
                const email = document.getElementById('email').value;
                
                if (!orderId && !email) {
                    alert('请输入订单号或邮箱');
                    return;
                }
                
                const response = await fetch('/api/search-order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ orderId, email })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    let html = '<h3>查询结果:</h3>';
                    
                    if (data.order) {
                        const order = data.order;
                        html += \`
                            <table>
                                <tr><th>订单号</th><td>\${order.id}</td></tr>
                                <tr><th>产品</th><td>\${order.type}</td></tr>
                                <tr><th>金额</th><td>¥\${order.price}</td></tr>
                                <tr><th>状态</th><td class="status-\${order.status.toLowerCase()}">\${order.status}</td></tr>
                                <tr><th>创建时间</th><td>\${new Date(order.created).toLocaleString()}</td></tr>
                                <tr><th>邮箱</th><td>\${order.email}</td></tr>
                                \${order.licenseKey ? \`
                                <tr><th>许可证</th><td><code>\${order.licenseKey}</code></td></tr>
                                <tr><th>操作</th><td><a href="/verify">验证许可证</a></td></tr>
                                \` : ''}
                            </table>
                        \`;
                    } else {
                        html += '<p>未找到相关订单</p>';
                    }
                    
                    document.getElementById('orderResult').innerHTML = html;
                } else {
                    alert('查询失败: ' + data.error);
                }
            }
        </script>
    </body>
    </html>
    `;
    
    res.send(html);
});

// ========== 📡 API 接口 ==========

// 创建订单
app.post('/api/create-order', (req, res) => {
    const { type, email, paymentMethod, qq, note } = req.body;
    
    if (!type || !email || !paymentMethod) {
        return res.json({ success: false, error: "缺少必要参数" });
    }
    
    if (!CONFIG.prices[type]) {
        return res.json({ success: false, error: "无效的产品类型" });
    }
    
    const order = createOrder(type, email, paymentMethod, { qq, note });
    
    res.json({
        success: true,
        orderId: order.id,
        message: "订单创建成功"
    });
});

// 确认支付
app.post('/api/confirm-payment/:orderId', (req, res) => {
    const orderId = req.params.orderId;
    
    // 模拟支付数据
    const paymentData = {
        transactionId: `TRX${Date.now()}`,
        payer: database.orders[orderId]?.email || "用户",
        amount: database.orders[orderId]?.price || 0,
        paidTime: new Date().toISOString()
    };
    
    const result = processPayment(orderId, paymentData);
    
    if (result.success) {
        // 发送邮件（模拟）
        sendLicenseEmail(result.order.email, result.license.key, result.order);
        
        res.json({
            success: true,
            order: result.order,
            license: result.license
        });
    } else {
        res.json(result);
    }
});

// 取消订单
app.post('/api/cancel-order/:orderId', (req, res) => {
    const orderId = req.params.orderId;
    const order = database.orders[orderId];
    
    if (!order) {
        return res.json({ success: false, error: "订单不存在" });
    }
    
    if (order.status === "PAID") {
        return res.json({ success: false, error: "已支付订单无法取消" });
    }
    
    order.status = "CANCELLED";
    log("ORDER_CANCELLED", orderId);
    
    res.json({
        success: true,
        message: "订单已取消"
    });
});

// 查询订单
app.post('/api/search-order', (req, res) => {
    const { orderId, email } = req.body;
    
    let order = null;
    
    if (orderId && database.orders[orderId]) {
        order = database.orders[orderId];
    } else if (email) {
        // 查找该邮箱的最近订单
        const orders = Object.values(database.orders).filter(o => o.email === email);
        if (orders.length > 0) {
            order = orders.sort((a, b) => new Date(b.created) - new Date(a.created))[0];
        }
    }
    
    res.json({
        success: true,
        order: order
    });
});

// 验证许可证（兼容之前的API）
app.post('/api/validate', (req, res) => {
    const { key, hwid } = req.body;
    
    const license = database.licenses[key];
    if (!license) {
        return res.json({ success: false, error: "许可证不存在" });
    }
    
    if (license.status === "BANNED") {
        return res.json({ success: false, error: "许可证已被封禁" });
    }
    
    const now = new Date();
    const expiry = new Date(license.expiry);
    if (now > expiry) {
        license.status = "EXPIRED";
        return res.json({ success: false, error: "许可证已过期" });
    }
    
    // 检查激活次数
    if (license.activations >= license.maxActivations) {
        return res.json({ success: false, error: "激活次数已达上限" });
    }
    
    // 检查HWID
    if (license.hwid.length > 0 && !license.hwid.includes(hwid)) {
        return res.json({ success: false, error: "设备未授权" });
    }
    
    license.lastUsed = now.toISOString();
    
    res.json({
        success: true,
        license: {
            key: license.key,
            type: license.type,
            expiry: license.expiry,
            activations: license.activations,
            maxActivations: license.maxActivations,
            remainingDays: Math.ceil((expiry - now) / (1000 * 60 * 60 * 24))
        },
        token: generateLicenseKey() // 生成临时令牌
    });
});

// ========== 🔐 管理员接口 ==========

// 管理员登录
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    
    if (password === CONFIG.adminPassword) {
        const token = crypto.randomBytes(32).toString('hex');
        database.adminToken = token;
        
        res.json({
            success: true,
            token: token,
            message: "登录成功"
        });
    } else {
        res.json({ success: false, error: "密码错误" });
    }
});

// 管理员统计
app.get('/api/admin/stats', (req, res) => {
    const token = req.headers['x-admin-token'];
    if (token !== database.adminToken) {
        return res.status(403).json({ success: false, error: "权限不足" });
    }
    
    res.json({
        success: true,
        stats: database.stats,
        orders: Object.keys(database.orders).length,
        licenses: Object.keys(database.licenses).length,
        recentOrders: Object.values(database.orders)
            .sort((a, b) => new Date(b.created) - new Date(a.created))
            .slice(0, 10)
    });
});

// ========== 🚀 启动服务器 ==========

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
    🚀 零食客户端商店服务器已启动！
    🌐 访问地址: http://localhost:${PORT}
    🔐 管理员密码: ${CONFIG.adminPassword}
    💰 价格体系:
      日卡: ¥${CONFIG.prices.DAY.price} (${CONFIG.prices.DAY.days}天)
      周卡: ¥${CONFIG.prices.WEEK.price} (${CONFIG.prices.WEEK.days}天)
      月卡: ¥${CONFIG.prices.MONTH.price} (${CONFIG.prices.MONTH.days}天)
      年卡: ¥${CONFIG.prices.YEAR.price} (${CONFIG.prices.YEAR.days}天)
      永久: ¥${CONFIG.prices.LIFETIME.price} (永久)
    
    📊 管理面板: http://localhost:${PORT}/admin
    🎫 验证页面: http://localhost:${PORT}/verify
    📋 订单查询: http://localhost:${PORT}/orders
    `);
});

module.exports = app;
