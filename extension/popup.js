async function checkReceiver() {
  try {
    await fetch('http://127.0.0.1:7239/annotation', { method: 'OPTIONS' })
    document.getElementById('status').textContent = '✅ 接收端运行中'
    document.getElementById('status').style.color = '#07c160'
  } catch {
    document.getElementById('status').textContent = '⚠️ 接收端未启动 (node receiver/index.js)'
    document.getElementById('status').style.color = '#e74c3c'
  }
}
checkReceiver()
