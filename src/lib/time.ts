import type { Contest } from "../domain/contest"

interface ZonedParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

export interface ParsedTime {
  readonly hour: number
  readonly minute: number
}

const zonedPartFormatterCache = new Map<string, Intl.DateTimeFormat>()
const contestTimeFormatterCache = new Map<string, Intl.DateTimeFormat>()
const humanDateFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  timeZone: "UTC"
})

const getZonedFormatter = (timeZone: string): Intl.DateTimeFormat => {
  const cached = zonedPartFormatterCache.get(timeZone)
  if (cached) {
    return cached
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  })

  zonedPartFormatterCache.set(timeZone, formatter)

  return formatter
}

const getContestTimeFormatter = (timeZone: string): Intl.DateTimeFormat => {
  const cached = contestTimeFormatterCache.get(timeZone)
  if (cached) {
    return cached
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  })

  contestTimeFormatterCache.set(timeZone, formatter)

  return formatter
}

export const getZonedParts = (date: Date, timeZone: string): ZonedParts => {
  const parts = getZonedFormatter(timeZone).formatToParts(date)
  const valueFor = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((entry) => entry.type === type)

    if (!part) {
      throw new Error(`Missing ${type} for timezone ${timeZone}`)
    }

    return Number(part.value)
  }

  return {
    year: valueFor("year"),
    month: valueFor("month"),
    day: valueFor("day"),
    hour: valueFor("hour"),
    minute: valueFor("minute"),
    second: valueFor("second")
  }
}

export const formatDateKeyInTimeZone = (date: Date, timeZone: string): string => {
  const parts = getZonedParts(date, timeZone)

  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0")
  ].join("-")
}

export const addDaysToDateKey = (dateKey: string, days: number): string => {
  const [yearText, monthText, dayText] = dateKey.split("-")
  if (!yearText || !monthText || !dayText) {
    throw new Error(`Invalid date key: ${dateKey}`)
  }

  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const value = new Date(Date.UTC(year, month - 1, day + days))

  return value.toISOString().slice(0, 10)
}

export const getTimeZoneOffsetMs = (date: Date, timeZone: string): number => {
  const zoned = getZonedParts(date, timeZone)
  const zonedAsUtc = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour,
    zoned.minute,
    zoned.second
  )

  return zonedAsUtc - date.getTime()
}

export const zonedDateTimeToUtc = (
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0
): Date => {
  let utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second))

  for (let index = 0; index < 2; index += 1) {
    const offset = getTimeZoneOffsetMs(utcGuess, timeZone)
    utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offset)
  }

  return utcGuess
}

export const computeDelayUntilNextRun = (
  now: Date,
  timeZone: string,
  hour: number,
  minute: number
): number => {
  const nowParts = getZonedParts(now, timeZone)
  const todayKey = formatDateKeyInTimeZone(now, timeZone)
  const shouldRollToTomorrow =
    nowParts.hour > hour || (nowParts.hour === hour && nowParts.minute >= minute)
  const targetKey = shouldRollToTomorrow ? addDaysToDateKey(todayKey, 1) : todayKey
  const [yearText, monthText, dayText] = targetKey.split("-")
  if (!yearText || !monthText || !dayText) {
    throw new Error(`Invalid date key: ${targetKey}`)
  }

  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const target = zonedDateTimeToUtc(timeZone, year, month, day, hour, minute)

  return Math.max(target.getTime() - now.getTime(), 0)
}

export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date())
    return true
  } catch {
    return false
  }
}

export const parseDeliveryTime = (value: string): ParsedTime | null => {
  const match = value.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/)
  if (!match) {
    return null
  }

  const hourText = match[1]
  const minuteText = match[2]

  if (!hourText || !minuteText) {
    return null
  }

  return {
    hour: Number(hourText),
    minute: Number(minuteText)
  }
}

export const formatDeliveryTime = (hour: number, minute: number): string =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`

export const getLocalMinuteOfDay = (date: Date, timeZone: string): number => {
  const parts = getZonedParts(date, timeZone)
  return parts.hour * 60 + parts.minute
}

export const isDigestDue = (
  now: Date,
  timeZone: string,
  hour: number,
  minute: number
): boolean => getLocalMinuteOfDay(now, timeZone) >= hour * 60 + minute

export const getTomorrowDateKey = (date: Date, timeZone: string): string =>
  addDaysToDateKey(formatDateKeyInTimeZone(date, timeZone), 1)

export const computeNextDeliveryAt = (
  now: Date,
  timeZone: string,
  hour: number,
  minute: number
): Date => {
  const delayMs = computeDelayUntilNextRun(now, timeZone, hour, minute)
  return new Date(now.getTime() + delayMs)
}

export const parseAtCoderDate = (value: string): Date => {
  const normalized = value.trim().replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2")

  return new Date(normalized)
}

export const parseDurationToMinutes = (value: string): number => {
  const [hoursText, minutesText] = value.trim().split(":")
  if (!hoursText || !minutesText) {
    throw new Error(`Invalid duration: ${value}`)
  }

  const hours = Number(hoursText)
  const minutes = Number(minutesText)

  return hours * 60 + minutes
}

export const formatContestStart = (date: Date, timeZone: string): string =>
  getContestTimeFormatter(timeZone).format(date)

export const formatDateKeyForHumans = (dateKey: string): string =>
  humanDateFormatter.format(new Date(`${dateKey}T00:00:00.000Z`))

export const formatDuration = (durationMinutes: number): string => {
  const hours = Math.floor(durationMinutes / 60)
  const minutes = durationMinutes % 60

  if (hours === 0) {
    return `${minutes}m`
  }

  if (minutes === 0) {
    return `${hours}h`
  }

  return `${hours}h ${minutes}m`
}

export const filterContestsByDateKey = (
  contests: ReadonlyArray<Contest>,
  dateKey: string,
  timeZone: string
): ReadonlyArray<Contest> =>
  contests.filter((contest) => formatDateKeyInTimeZone(contest.startAt, timeZone) === dateKey)

export const sortContests = (contests: ReadonlyArray<Contest>): ReadonlyArray<Contest> =>
  [...contests].sort((left, right) => {
    const startDelta = left.startAt.getTime() - right.startAt.getTime()
    if (startDelta !== 0) {
      return startDelta
    }

    const platformDelta = left.platform.localeCompare(right.platform)
    if (platformDelta !== 0) {
      return platformDelta
    }

    return left.title.localeCompare(right.title)
  })
