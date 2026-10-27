// Match the actual pre-sleep guard: an explicitly disabled wait must never be
// presented to the model as a required tool call.
export function preSleepGuidance(wake = {}) {
  if (wake.preSleepWaitEnabled === false) {
    return { text: '【收尾】处理完就标记已读并设置下一次唤醒；只有确需确认对方是否补充时才等待。\n\n',
      closing: '你可以查看未读消息、人设、状态，自行决定是否发言；处理完就标记已读并设置下一次唤醒。' };
  }
  const waitMs = Math.max(0, Number(wake.preSleepWaitMs) || 300000);
  return { text: `【沉睡前强制等待】这是决定潜水收尾时的步骤，不是首回复的前置条件。除非对方明确说“不聊了/晚安/下了/拜拜”等结束语，否则每次设置潜水/下一次唤醒前，必须先调用 qq_wait_for_messages(timeoutMs=${waitMs}) 完成一次沉睡前观察；回复前 purpose="reply" 的短静默不能代替这次完整观察。若 ${Math.round(waitMs / 60000)} 分钟内没人说话，返回 preSleepWaitSatisfied=true，可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看返回的 newMessages——判断不需要你参与就可以直接沉睡，若你选择参与回复，则下次想睡时需要重新等待观察窗口。【不要靠猜】：等待返回里的 canSleepNow/hint 就是闸门的判断结果——canSleepNow=true 立刻收尾（mark_read 或 set_wake_config）；false 时按 hint 给出的 timeoutMs 一次等满，别用更短的 timeoutMs 去凑（更短的等待不算观察，只会白等一轮）。\n\n`,
    closing: '你可以调用工具查看未读消息、人设、状态，自行决定是否发言；决定潜水前必须按上面的【沉睡前强制等待】先等够观察窗口。' };
}
