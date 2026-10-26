import {
  groupPlayRecords,
  siblingKeys,
  splitRecordKey,
} from './play-record-groups';

const record = (
  title: string,
  total: number,
  saveTime: number,
  year = '2026'
) => ({ title, year, total_episodes: total, save_time: saveTime });

describe('groupPlayRecords', () => {
  it('shows one card per show even when it was watched on several lines', () => {
    const groups = groupPlayRecords({
      'liangzi+1': record('DoctorX：白色黑手党', 5, 200),
      'guangsu+9': record('Doctor X：白色黑手党', 3, 100),
      'other+2': record('三体', 30, 150),
    });
    expect(groups).toHaveLength(2);
    expect(groups[0].latest.key).toBe('liangzi+1');
    expect(groups[0].keys).toEqual(['liangzi+1', 'guangsu+9']);
    expect(groups[1].latest.title).toBe('三体');
  });

  it('takes the newest episode count among the lines', () => {
    const [group] = groupPlayRecords({
      'a+1': record('Doctor X', 5, 300),
      'b+1': record('DoctorX', 6, 100),
    });
    expect(group.latest.key).toBe('a+1');
    expect(group.totalEpisodes).toBe(6);
  });

  it('keeps different years apart but joins a record without a year', () => {
    const groups = groupPlayRecords({
      'a+1': record('三体', 30, 300, '2023'),
      'b+1': record('三体', 30, 200, '2010'),
      'c+1': record('三体', 30, 100, ''),
    });
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.keys.length).sort()).toEqual([1, 2]);
  });

  it('keeps a movie and a series with the same name apart', () => {
    expect(
      groupPlayRecords({
        'a+1': record('长安', 1, 2),
        'b+1': record('长安', 40, 1),
      })
    ).toHaveLength(2);
  });

  it('finds the other records of the same show', () => {
    const records = {
      'a+1': record('Doctor X', 5, 3),
      'b+2': record('DoctorX', 6, 2),
      'c+3': record('三体', 30, 1),
    };
    expect(siblingKeys(records, 'a+1')).toEqual(['b+2']);
    expect(siblingKeys(records, 'c+3')).toEqual([]);
    expect(siblingKeys(records, 'missing+1')).toEqual([]);
  });

  it('splits keys whose id contains a plus sign', () => {
    expect(splitRecordKey('src+a+b')).toEqual({ source: 'src', id: 'a+b' });
  });
});
