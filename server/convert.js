const { load, WEEKDAY_NAMES, MIN_YEAR, MAX_YEAR } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86400000;

// 边界判定口径的页面说明，换算结果里原样带回，前端直接展示
const BOUNDARY_STATEMENT = `换算边界按整数年份判定，不看具体月日：工具支持 ${MIN_YEAR} 至 ${MAX_YEAR} 年；档案生效的第一年（含该年 1 月 1 日）与停止实行夏令时的最后一年（含该年 12 月 31 日）都算可用，落在边界外的档案标为不可用并给出原因，不影响其余档案换算`;

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

// 换算的两端边界，按整数年份判定、不看具体月日，三种越界各自给出原因：
// 超出工具支持范围、早于档案生效年份、晚于档案停止实行夏令时的年份。
// 边界含端点：生效的第一年与停止的最后一年都算可用
function availabilityFor(zone, year) {
  if (year < MIN_YEAR || year > MAX_YEAR) {
    return {
      available: false,
      code: 'OUT_OF_SUPPORTED_RANGE',
      reason: `超出工具支持的年份范围（${MIN_YEAR} 至 ${MAX_YEAR} 年）`,
    };
  }
  if (year < zone.fromYear) {
    return {
      available: false,
      code: 'BEFORE_FROM_YEAR',
      reason: `早于档案生效年份（${zone.fromYear} 年起）`,
    };
  }
  if (zone.toYear !== null && year > zone.toYear) {
    return {
      available: false,
      code: 'AFTER_TO_YEAR',
      reason: zone.usesDst
        ? `晚于档案停止实行夏令时的年份（${zone.toYear} 年止）`
        : `晚于档案生效截止年份（${zone.toYear} 年止）`,
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
    const availability = availabilityFor(zone, date.year);
    const row = {
      zoneId: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      offsetMinutes: zone.offsetMinutes,
      offsetText: offsetText(zone.offsetMinutes),
      fromYear: zone.fromYear,
      toYear: zone.toYear,
      usesDst: zone.usesDst,
      isSource: zone.id === source.id,
      available: availability.available,
      unavailableCode: availability.code,
      unavailableReason: availability.reason,
    };
    // 越界的档案只标不可用与原因，不给换算值：年份落在边界外，算出来的东西没有依据
    if (!availability.available) {
      return {
        ...row,
        localDate: null,
        localTime: null,
        weekday: null,
        dayOffset: null,
        dayOffsetText: null,
        diffMinutes: null,
        diffText: null,
      };
    }
    const localMs = utcMs + zone.offsetMinutes * 60000;
    const local = new Date(localMs);
    const dayOffset = Math.floor(localMs / DAY_MS) - baseDay;
    const diffMinutes = zone.offsetMinutes - source.offsetMinutes;
    return {
      ...row,
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

  // 统计只覆盖可用档案，越界档案没有换算值，不参与跨天与时差统计
  const usable = results.filter((item) => item.available);

  return {
    input: {
      date: date.text,
      time: time.text,
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
      mode: 'year',
      modeText: '按整数年份判定',
      minYear: MIN_YEAR,
      maxYear: MAX_YEAR,
      text: BOUNDARY_STATEMENT,
    },
    zonesInScope: data.zones.length,
    availableCount: usable.length,
    unavailableCount: results.length - usable.length,
    crossDayCount: usable.filter((item) => item.dayOffset !== 0).length,
    maxDiffMinutes: usable.reduce((acc, item) => Math.max(acc, Math.abs(item.diffMinutes)), 0),
    results,
    convertedAt: new Date().toISOString(),
  };
}

module.exports = { convert, validateDate, validateTime, diffText, dayOffsetText, availabilityFor, BOUNDARY_STATEMENT };
