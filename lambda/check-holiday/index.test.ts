// holiday_jpモジュールをモック
const mockIsHoliday = jest.fn();
const mockBetween = jest.fn();

jest.mock('@holiday-jp/holiday_jp', () => ({
  __esModule: true,
  default: {
    isHoliday: mockIsHoliday,
    between: mockBetween,
  },
}));

import { handler } from './index';

interface LambdaResponse {
  isHoliday: boolean;
  date: string;
  holidayName?: string;
}

describe('check-holiday Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Dateのモック
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('祝日の場合はisHoliday=trueを返す', async () => {
    // 2024年1月1日（元日）をモック
    jest.setSystemTime(new Date('2024-01-01T00:30:00Z')); // UTC 0:30 = JST 9:30

    mockIsHoliday.mockReturnValue(true);
    mockBetween.mockReturnValue([
      {
        date: new Date('2024-01-01'),
        week: '月',
        week_en: 'Monday',
        name: '元日',
        name_en: "New Year's Day",
      },
    ]);

    const result = await handler({}, {} as any, {} as any) as LambdaResponse;

    expect(result.isHoliday).toBe(true);
    expect(result.holidayName).toBe('元日');
    expect(result.date).toBe('2024-01-01');
  });

  it('平日の場合はisHoliday=falseを返す', async () => {
    // 2024年1月4日（木曜日、平日）をモック
    jest.setSystemTime(new Date('2024-01-04T00:30:00Z')); // UTC 0:30 = JST 9:30

    mockIsHoliday.mockReturnValue(false);

    const result = await handler({}, {} as any, {} as any) as LambdaResponse;

    expect(result.isHoliday).toBe(false);
    expect(result.holidayName).toBeUndefined();
    expect(result.date).toBe('2024-01-04');
  });

  it('振替休日の場合もisHoliday=trueを返す', async () => {
    // 2024年2月12日（振替休日：建国記念の日の振替）をモック
    jest.setSystemTime(new Date('2024-02-12T00:30:00Z'));

    mockIsHoliday.mockReturnValue(true);
    mockBetween.mockReturnValue([
      {
        date: new Date('2024-02-12'),
        week: '月',
        week_en: 'Monday',
        name: '振替休日',
        name_en: 'Substitute Holiday',
      },
    ]);

    const result = await handler({}, {} as any, {} as any) as LambdaResponse;

    expect(result.isHoliday).toBe(true);
    expect(result.holidayName).toBe('振替休日');
    expect(result.date).toBe('2024-02-12');
  });

  it('祝日だがbetweenが空配列を返す場合はデフォルト名を使用', async () => {
    jest.setSystemTime(new Date('2024-01-01T00:30:00Z'));

    mockIsHoliday.mockReturnValue(true);
    mockBetween.mockReturnValue([]);

    const result = await handler({}, {} as any, {} as any) as LambdaResponse;

    expect(result.isHoliday).toBe(true);
    expect(result.holidayName).toBe('祝日');
  });

  it('エラー時はisHoliday=falseを返す（処理継続）', async () => {
    jest.setSystemTime(new Date('2024-01-04T00:30:00Z'));

    mockIsHoliday.mockImplementation(() => {
      throw new Error('API error');
    });

    const result = await handler({}, {} as any, {} as any) as LambdaResponse;

    expect(result.isHoliday).toBe(false);
  });
});
