/*
 * @Date: 2025-06-07 10:06:12
 * @Description: 日志工具
 */
const chalk = require('chalk');

/**
 * 日志级别
 * @enum {number}
 */
const LogLevel = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    SUCCESS: 4,
    NONE: 5
};

/**
 * 日志工具
 */
const logger = {
    // 当前日志级别
    level: LogLevel.INFO,
    
    // 是否静默模式
    silent: false,
    
    /**
     * 设置日志级别
     * @param {LogLevel} level 日志级别
     */
    setLevel(level) {
        this.level = level;
    },
    
    /**
     * 设置静默模式
     * @param {boolean} silent 是否静默
     */
    setSilent(silent) {
        this.silent = silent;
    },
    
    /**
     * 调试日志
     * @param {string} message 日志消息
     * @param {...any} args 附加参数
     */
    debug(message, ...args) {
        if (this.level <= LogLevel.DEBUG && !this.silent) {
            console.log(chalk.gray(`[DEBUG] ${message}`), ...args);
        }
    },
    
    /**
     * 信息日志
     * @param {string} message 日志消息
     * @param {...any} args 附加参数
     */
    info(message, ...args) {
        if (this.level <= LogLevel.INFO && !this.silent) {
            console.log(chalk.blue(`[INFO] ${message}`), ...args);
        }
    },
    
    /**
     * 警告日志
     * @param {string} message 日志消息
     * @param {...any} args 附加参数
     */
    warn(message, ...args) {
        if (this.level <= LogLevel.WARN && !this.silent) {
            console.log(chalk.yellow(`[WARN] ${message}`), ...args);
        }
    },
    
    /**
     * 错误日志
     * @param {string} message 日志消息
     * @param {...any} args 附加参数
     */
    error(message, ...args) {
        if (this.level <= LogLevel.ERROR && !this.silent) {
            console.log(chalk.red(`[ERROR] ${message}`), ...args);
        }
    },
    
    /**
     * 成功日志
     * @param {string} message 日志消息
     * @param {...any} args 附加参数
     */
    success(message, ...args) {
        if (this.level <= LogLevel.SUCCESS && !this.silent) {
            console.log(chalk.green(`[SUCCESS] ${message}`), ...args);
        }
    },
    
    /**
     * 分隔线
     * @param {string} char 分隔字符
     * @param {number} length 长度
     */
    separator(char = '-', length = 80) {
        if (!this.silent) {
            console.log(chalk.gray(char.repeat(length)));
        }
    },
    
    /**
     * 进度条
     * @param {number} current 当前进度
     * @param {number} total 总进度
     * @param {string} label 标签
     */
    progress(current, total, label = '') {
        if (this.silent) return;
        
        const percent = Math.floor((current / total) * 100);
        const barLength = 40;
        const filledLength = Math.floor((current / total) * barLength);
        const emptyLength = barLength - filledLength;
        
        // 构建进度条
        const bar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);
        
        // 构建输出
        const output = `[${bar}] ${percent}% ${current}/${total} ${label}`;
        
        // 输出进度条（覆盖当前行）
        process.stdout.write(`\r${output}`);
        
        // 如果完成，添加换行
        if (current === total) {
            process.stdout.write('\n');
        }
    }
};

// 导出
module.exports = { logger, LogLevel }; 