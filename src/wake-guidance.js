// Match the actual pre-sleep guard: an explicitly disabled wait must never be
// presented to the model as a required tool call.
//
// 提示词里刻意**不写** `qq_wait_for_messages(timeoutMs=300000)` 这种伪代码：
// 模型会把 `参数=值` 照抄进工具参数，DeepSeek 侧直接报 `tool input is invalid JSON`，
// 整个回合就废了（线上 14:30/14:31/14:32/14:53 连报四次，都紧跟在这类提示之后）。
/**
 * 她的身体/内心/心情记录太久没更新时，提醒她先更新再说话。
 *
 * 为什么需要：`state/body.json` 可能是早上 7 点写的，下午 3 点她还照着说「刚醒，脑子发懵」——
 * 用户看到的就是「她怎么怪怪的」。6 小时是经验值：一个作息段内该刷新一次。
 *
 * @param {{body?:number, inner?:number, mood?:number}} ages 各文件距今多少毫秒（undefined = 没有这个文件）
 * @param {number} hours 超过多少小时算过期
 */
export function staleSelfStateHint(ages = {}, hours = 6) {
  const limit = Math.max(1, Number(hours) || 6) * 3600 * 1000;
  const labels = [
    ['body', '身体', 'qq_body'],
    ['inner', '内心', 'qq_inner_state'],
    ['mood', '心情', 'qq_mood'],
  ];
  const stale = [];
  for (const [field, label, tool] of labels) {
    const age = ages?.[field];
    // 没有文件也算过期：她可能从来没记过，那就更该先记一次
    if (age === undefined || !Number.isFinite(age) || age > limit) {
      const when = Number.isFinite(age) && age >= 0 ? `${Math.round(age / 3600000)} 小时前记的` : '还没记过';
      stale.push(`${label}（${tool}，${when}）`);
    }
  }
  if (!stale.length) return '';
  return `【先更新你自己】${stale.join('、')}已经过期。回应之前先按此刻真实的感受把它们更新一下，别把半天前的状态当成现在——今天真发生过：下午三点她还在说「刚醒」。\n\n`;
}

export function preSleepGuidance(wake = {}) {
  if (wake.preSleepWaitEnabled === false) {
    return { text: '【收尾】处理完就标记已读并设置下一次唤醒；只有确需确认对方是否补充时才等待。\n\n',
      closing: '你可以查看未读消息、人设、状态，自行决定是否发言；处理完就标记已读并设置下一次唤醒。' };
  }
  const waitMs = Math.max(0, Number(wake.preSleepWaitMs) || 300000);
  return { text: `【沉睡前强制等待】这是决定潜水收尾时的步骤，不是首回复的前置条件。除非对方明确说“不聊了/晚安/下了/拜拜”等结束语，否则每次设置潜水/下一次唤醒前，必须先调用 qq_wait_for_messages 完成一次沉睡前观察，把它的 timeoutMs 参数设为 ${waitMs}；回复前那个短静默（purpose 填 reply）不能代替这次完整观察。若 ${Math.round(waitMs / 60000)} 分钟内没人说话，返回 preSleepWaitSatisfied=true，可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看返回的 newMessages——判断不需要你参与就可以直接沉睡，若你选择参与回复，则下次想睡时需要重新等待观察窗口。【不要靠猜】：等待返回里的 canSleepNow/hint 就是闸门的判断结果——canSleepNow=true 立刻收尾（标记已读，或设置下一次唤醒）；false 时按 hint 给出的时长一次等满，别用更短的等待去凑（更短的等待不算观察，只会白等一轮）。【参数写法】调用工具时参数必须是 JSON 对象（键名带引号），不要写成 参数=值 —— 那样会被判为非法 JSON，这一轮就白跑了。\n\n`,
    closing: '你可以调用工具查看未读消息、人设、状态，自行决定是否发言；决定潜水前必须按上面的【沉睡前强制等待】先等够观察窗口。' };
}
