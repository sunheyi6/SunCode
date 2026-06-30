export function getFantasyWelcomeMessage(now = new Date()): string {
  const hour = now.getHours();

  if (hour >= 5 && hour < 11) {
    return '晨光越过星尘，新的冒险已经醒来';
  }
  if (hour >= 11 && hour < 14) {
    return '日冕正悬高塔，灵感在光里展开';
  }
  if (hour >= 14 && hour < 18) {
    return '云塔投下金影，继续锻造今天的咒文';
  }
  if (hour >= 18 && hour < 24) {
    return '星火点亮暮色，今晚也适合召唤奇迹';
  }
  return '月潮漫过静夜，秘密的灵感正在靠岸';
}
