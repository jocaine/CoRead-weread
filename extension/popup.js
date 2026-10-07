async function checkReceiver() {
  try {
    await fetch('http://127.0.0.1:7239/annotation', { method: 'OPTIONS' })
    document.getElementById('status').textContent = 'CoRead 本机服务运行中'
    document.getElementById('status').style.color = '#07c160'
  } catch {
    document.getElementById('status').textContent = 'CoRead 本机服务未启动，请运行 Start-CoRead.vbs'
    document.getElementById('status').style.color = '#e74c3c'
  }
}
checkReceiver()
