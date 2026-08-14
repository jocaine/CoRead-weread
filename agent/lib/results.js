/**
 * 结果文件（judge-real-results.json）的判专题化结论存取。
 *
 * `results`（逐条 topicized 判定）是瞬态中间数据：judge 写、group 消费后从文件丢弃。
 * group 的分组输出分布式编码了同样的信息，可用 reconstructTopicized 精确重建：
 *   - discussions[].excerpts[].topicized（入组消息各自的判专题化结论）
 *   - ignored[].topicized（恒 false）
 *   - errors[].topicized（判同一性失败消息的判专题化结论）
 * 跨重提取按 timestamp（源时间戳）关联，稳定不变（id 会移位）。
 */
export function reconstructTopicized(prevRes) {
  const m = new Map()
  for (const d of prevRes.discussions || [])
    for (const e of d.excerpts || []) m.set(e.t, e.topicized ?? true)
  for (const i of prevRes.ignored || []) m.set(i.timestamp, i.topicized ?? false)
  for (const er of prevRes.errors || []) if (er.topicized !== undefined) m.set(er.timestamp, er.topicized)
  return m
}
