/*
 * @Date: 2025-06-07 10:06:12
 * @Description: 构建脚本
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ora = require('ora');
const chalk = require('chalk');

// 构建目录
const BUILD_DIR = path.join(__dirname, '../dist');
const PKG_PATH = path.join(__dirname, '../package.json');

/**
 * 清理目录
 * @param {string} dir 要清理的目录
 */
function cleanDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 复制文件
 * @param {string} src 源文件
 * @param {string} dest 目标文件
 */
function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
}

/**
 * 复制目录
 * @param {string} src 源目录
 * @param {string} dest 目标目录
 */
function copyDir(src, dest) {
  // 确保目标目录存在
  fs.mkdirSync(dest, { recursive: true });
  
  // 读取源目录
  const files = fs.readdirSync(src);
  
  for (const file of files) {
    const srcPath = path.join(src, file);
    const destPath = path.join(dest, file);
    
    // 获取文件状态
    const stat = fs.statSync(srcPath);
    
    if (stat.isDirectory()) {
      // 递归复制子目录
      copyDir(srcPath, destPath);
    } else {
      // 复制文件
      copyFile(srcPath, destPath);
    }
  }
}

/**
 * 构建项目
 */
function build() {
  const spinner = ora('开始构建项目...').start();
  
  try {
    // 1. 清理构建目录
    spinner.text = '清理构建目录...';
    cleanDir(BUILD_DIR);
    
    // 2. 复制源文件
    spinner.text = '复制源文件...';
    copyDir(path.join(__dirname, '../src'), path.join(BUILD_DIR, 'src'));
    copyDir(path.join(__dirname, '../bin'), path.join(BUILD_DIR, 'bin'));
    
    // 3. 复制配置文件
    spinner.text = '复制配置文件...';
    copyFile(path.join(__dirname, '../package.json'), path.join(BUILD_DIR, 'package.json'));
    copyFile(path.join(__dirname, '../README.md'), path.join(BUILD_DIR, 'README.md'));
    copyFile(path.join(__dirname, '../cc-reverse.config.js'), 
             path.join(BUILD_DIR, 'cc-reverse.config.js'));
    
    // 4. 设置bin权限
    spinner.text = '设置执行权限...';
    fs.chmodSync(path.join(BUILD_DIR, 'bin/cc-reverse.js'), '755');
    
    // 5. 安装依赖
    spinner.text = '安装依赖...';
    process.chdir(BUILD_DIR);
    execSync('npm install --production', { stdio: 'ignore' });
    
    // 6. 完成构建
    spinner.succeed(chalk.green('项目构建完成！'));
    console.log(`\n构建目录: ${chalk.cyan(BUILD_DIR)}`);
    console.log(`\n安装: ${chalk.yellow('npm install -g ' + BUILD_DIR)}`);
    console.log(`运行: ${chalk.yellow('cc-reverse --path <源项目路径>')}`);
    
  } catch (err) {
    spinner.fail(chalk.red('构建失败!'));
    console.error(err);
    process.exit(1);
  }
}

// 执行构建
build(); 