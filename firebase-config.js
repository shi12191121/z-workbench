/* =========================================================
 * Firebase 云端配置（z的工作台 专用）
 * ---------------------------------------------------------
 * 【作用】把全部打卡 / 签到 / 任务数据实时写入 Firebase 实时数据库，
 *        手机和电脑打开网页自动拉取最新数据，任意一端修改另一端秒级同步。
 *
 * 【怎么填】（详细步骤见《使用教程.md》第②部分）：
 *   1. 打开 https://console.firebase.google.com 新建一个项目（免费）
 *   2. 左侧「构建」→「Realtime Database」→ 创建数据库（选亚洲/美东节点）
 *   3. 项目设置（齿轮图标）→「你的应用」→ 添加 Web 应用 → 复制配置
 *   4. 把下面 firebaseConfig 里的占位符替换成你的真实值
 *   5. 数据库规则 Rules 设为可读写（教程里有现成代码）
 *
 * 【判断开关】FB_CONFIGURED 自动检测：只要 apiKey 不是占位符就视为已配置，
 *            此时网页自动切换为「云端实时存储 + 多端同步」模式；
 *            未配置时自动降级为「浏览器本地存储」，双击 html 也能正常用。
 * ========================================================= */
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  databaseURL:       "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId:         "YOUR_PROJECT",
  appId:             "YOUR_APP_ID"
};

// 是否已填入真实配置（含 YOUR_ 即视为未配置）
const FB_CONFIGURED = !/YOUR_/.test(JSON.stringify(firebaseConfig));

// 显式挂载到 window，确保 app.js 在任何加载顺序下都能读取
window.firebaseConfig = firebaseConfig;
window.FB_CONFIGURED = FB_CONFIGURED;
