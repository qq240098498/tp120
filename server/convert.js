const { load, WEEKDAY_NAMES, MIN_YEAR, MAX_YEAR } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86400000;

const pad = (num) => String(num).padStart(2, '0');

// 日期要真存在，例如 2026-02-30 这种不能算数
function validateDate(value) {
  const date = pickText(value);
  if (!date) throw new ApiError(400, 'DATE_REQUIRED', '请填写日期', 'date');
  if (!DATE_PATTERN.test(date)) {
    throw new ApiError(400, 'DATE_INVALID', '日期要写成四位年加短横线加两位月日，例如 2026-09-20', 'date');
  }
  const [year, month, day] = date.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，请检查月份与日', 'date');
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，例如二月没有三十号', 'date');
  }
  return { text: date, year, month, day };
}

function validateTime(value) {
  const time = pickText(value);
  if (!time) throw new ApiError(400, 'TIME_REQUIRED', '请填写时刻', 'time');
  if (!TIME_PATTERN.test(time)) {
    throw new ApiError(400, 'TIME_INVALID', '时刻要写成两位小时加冒号加两位分钟，例如 09:30', 'time');
  }
  const [hour, minute] = time.split(':').map(Number);
  return { text: time, hour, minute };
}

// 时差写法：整小时只写小时，带分钟的把分钟也写出来
function diffText(minutes) {
  if (minutes === 0) return '与源时区相同';
  const sign = minutes > 0 ? '早' : '晚';
  const abs = Math.abs(minutes);
  const hour = Math.floor(abs / 60);
  const minute = abs % 60;
  const parts = [];
  if (hour) parts.push(`${hour} 小时`);
  if (minute) parts.push(`${minute} 分`);
  return `比源时区${sign} ${parts.join(' ')}`;
}

function dayOffsetText(dayOffset) {
  if (dayOffset === 0) return '同日';
  if (dayOffset > 0) return `后 ${dayOffset} 天`;
  return `前 ${Math.abs(dayOffset)} 天`;
}

// 年份边界按整数年份判定，不看具体月日：开始年份与停止年份都算在可用范围内，
// 也就是生效第一年的第一天与停止实行最后一年的最后一天都照常换算。
// 三种越界分开标记，换算本身不因此失败，越界的档案只在结果里标成不可用
function checkYearBoundary(zone, year) {
  if (year < MIN_YEAR || year > MAX_YEAR) {
    return {
      available: false,
      code: 'YEAR_OUT_OF_TOOL_RANGE',
      reason: `超出工具支持的年份范围（${MIN_YEAR} 至 ${MAX_YEAR}）`,
    };
  }
  if (year < zone.fromYear) {
    return {
      available: false,
      code: 'YEAR_BEFORE_FROM',
      reason: `早于档案生效年份（${zone.fromYear} 年起）`,
    };
  }
  if (zone.toYear !== null && year > zone.toYear) {
    return {
      available: false,
      code: 'YEAR_AFTER_TO',
      reason: `晚于档案停止实行的年份（${zone.toYear} 年止）`,
    };
  }
  return { available: true, code: '', reason: '' };
}

// 换算：先把输入时刻按来源时区的偏移折算成基准时刻，再逐个时区加上各自的偏移
function convert(options) {
  const input = options && typeof options === 'object' ? options : {};
  const date = validateDate(input.date);
  const time = validateTime(input.time);
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择来源时区', 'zoneId');

  const data = load();
  const source = data.zones.find((item) => item.id === zoneId);
  if (!source) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的时区没有登记过', 'zoneId');

  const baseMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const utcMs = baseMs - source.offsetMinutes * 60000;
  const baseDay = Math.floor(baseMs / DAY_MS);
  const utcDate = new Date(utcMs);

  const results = data.zones.map((zone) => {
    const boundary = checkYearBoundary(zone, date.year);
    const base = {
      zoneId: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      offsetMinutes: zone.offsetMinutes,
      offsetText: offsetText(zone.offsetMinutes),
      usesDst: zone.usesDst,
      isSource: zone.id === source.id,
      available: boundary.available,
      unavailableCode: boundary.code,
      unavailableReason: boundary.reason,
    };
    if (!boundary.available) {
      return {
        ...base,
        localDate: '',
        localTime: '',
        weekday: '',
        dayOffset: null,
        dayOffsetText: '',
        diffMinutes: null,
        diffText: '',
      };
    }
    const localMs = utcMs + zone.offsetMinutes * 60000;
    const local = new Date(localMs);
    const dayOffset = Math.floor(localMs / DAY_MS) - baseDay;
    const diffMinutes = zone.offsetMinutes - source.offsetMinutes;
    return {
      ...base,
      localDate: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
      localTime: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
      weekday: WEEKDAY_NAMES[local.getUTCDay()],
      dayOffset,
      dayOffsetText: dayOffsetText(dayOffset),
      diffMinutes,
      diffText: diffText(diffMinutes),
    };
  });

  results.sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.name < b.name ? -1 : 1;
  });

  // 跨天与时差统计只按可用档案算，越界档案没有换算结果，不参与统计
  const usable = results.filter((item) => item.available);
  const blocked = results
    .filter((item) => !item.available)
    .map((item) => ({
      zoneId: item.zoneId,
      name: item.name,
      displayName: item.displayName,
      code: item.unavailableCode,
      reason: item.unavailableReason,
    }));

  return {
    input: {
      date: date.text,
      time: time.text,
      year: date.year,
      zoneId: source.id,
      zoneName: source.name,
      zoneDisplayName: source.displayName,
      offsetText: offsetText(source.offsetMinutes),
      usesDst: source.usesDst,
    },
    standard: {
      date: `${utcDate.getUTCFullYear()}-${pad(utcDate.getUTCMonth() + 1)}-${pad(utcDate.getUTCDate())}`,
      time: `${pad(utcDate.getUTCHours())}:${pad(utcDate.getUTCMinutes())}`,
    },
    boundary: {
      minYear: MIN_YEAR,
      maxYear: MAX_YEAR,
      granularity: 'year',
      granularityText: '按整数年份判定，开始年份与停止年份都算可用',
    },
    zonesInScope: data.zones.length,
    availableCount: usable.length,
    unavailableCount: blocked.length,
    blocked,
    crossDayCount: usable.filter((item) => item.dayOffset !== 0).length,
    maxDiffMinutes: usable.reduce((acc, item) => Math.max(acc, Math.abs(item.diffMinutes)), 0),
    results,
    convertedAt: new Date().toISOString(),
  };
}

module.exports = { convert, validateDate, validateTime, diffText, dayOffsetText, checkYearBoundary };
