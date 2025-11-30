'use client';

import { X, Globe, Clock, Sparkles, Heart, Shield, MapPin, Navigation, Cloud, Sun, CloudRain, CloudSnow, CloudLightning, Wind } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// 位置信息类型
interface LocationInfo {
  ip: string;
  city: string;
  region: string;
  country: string;
  lat: number;
  lon: number;
}

// 天气信息类型
interface WeatherInfo {
  temp: number;
  description: string;
  icon: string;
}

// 欢迎弹窗组件，首次访问网站时显示免责声明和赞赏码
export const WelcomeModal: React.FC = () => {
  // 控制弹窗显示状态
  const [isOpen, setIsOpen] = useState(false);
  // 确保组件已在客户端挂载
  const [mounted, setMounted] = useState(false);
  // 位置信息
  const [location, setLocation] = useState<LocationInfo | null>(null);
  // 天气信息
  const [weather, setWeather] = useState<WeatherInfo | null>(null);
  // 加载状态
  const [loading, setLoading] = useState(true);
  // 当前时间
  const [currentTime, setCurrentTime] = useState<string>('');
  // 动画状态
  const [isAnimated, setIsAnimated] = useState(false);

  useEffect(() => {
    setMounted(true);

    // 检查是否已经显示过弹窗（使用sessionStorage，每次会话只显示一次）
    const hasShownWelcome = sessionStorage.getItem('hasShownWelcome');
    if (!hasShownWelcome) {
      setIsOpen(true);
      // 延迟启动动画
      setTimeout(() => setIsAnimated(true), 50);
    }

    // 带超时的fetch
    const fetchWithTimeout = (url: string, timeout = 3000): Promise<Response> => {
      return Promise.race([
        fetch(url),
        new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout))
      ]);
    };

    // 获取IP、位置和天气信息
    const fetchLocationAndWeather = async () => {
      try {
        let ipData = null;

        // 国内API优先（速度快）
        const apis = [
          // 太平洋网络IP查询
          async () => {
            const res = await fetchWithTimeout('https://whois.pconline.com.cn/ipJson.jsp?json=true', 2000);
            const text = await res.text();
            const data = JSON.parse(text);
            if (data.ip) return { ip: data.ip, city: data.city || '未知', region: data.pro || '未知', country: '中国', lat: 0, lon: 0 };
            return null;
          },
          // ip.useragentinfo
          async () => {
            const res = await fetchWithTimeout('https://ip.useragentinfo.com/json', 2000);
            const data = await res.json();
            if (data.ip) return { ip: data.ip, city: data.city || '未知', region: data.province || '未知', country: data.country || '未知', lat: 0, lon: 0 };
            return null;
          },
          // 国外备用
          async () => {
            const res = await fetchWithTimeout('https://ipwho.is/', 3000);
            const data = await res.json();
            if (data.success) return { ip: data.ip, city: data.city, region: data.region, country: data.country, lat: data.latitude, lon: data.longitude };
            return null;
          }
        ];

        for (const api of apis) {
          try {
            const result = await api();
            if (result) { ipData = result; break; }
          } catch { continue; }
        }

        if (ipData) {
          setLocation(ipData);
          // 使用和风天气API获取天气
          if (ipData.city && ipData.city !== '未知') {
            try {
              const QWEATHER_KEY = 'e976470c9f4f4a78b8006e69bef01fc4';
              // 先通过城市名获取LocationID
              const geoRes = await fetchWithTimeout(
                `https://geoapi.qweather.com/v2/city/lookup?location=${encodeURIComponent(ipData.city)}&key=${QWEATHER_KEY}`,
                3000
              );
              const geoData = await geoRes.json();
              if (geoData.code === '200' && geoData.location?.[0]) {
                const locationId = geoData.location[0].id;
                // 获取实时天气
                const weatherRes = await fetchWithTimeout(
                  `https://devapi.qweather.com/v7/weather/now?location=${locationId}&key=${QWEATHER_KEY}`,
                  3000
                );
                const weatherData = await weatherRes.json();
                if (weatherData.code === '200' && weatherData.now) {
                  setWeather({
                    temp: parseInt(weatherData.now.temp),
                    description: weatherData.now.text,
                    icon: weatherData.now.icon
                  });
                }
              }
            } catch { /* 天气获取失败 */ }
          }
        }
      } catch { /* 全部失败 */ }
      finally { setLoading(false); }
    };
    fetchLocationAndWeather();

    // 设置当前时间
    const updateTime = () => {
      const now = new Date();
      setCurrentTime(now.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }));
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);

    return () => clearInterval(timer);
  }, []);

  // 关闭弹窗并记录状态
  const handleClose = () => {
    setIsAnimated(false);
    setTimeout(() => {
      setIsOpen(false);
      sessionStorage.setItem('hasShownWelcome', 'true');
    }, 200);
  };

  // 根据和风天气图标代码获取对应图标
  const getWeatherIcon = (code: string) => {
    const codeNum = parseInt(code);
    // 晴天 100, 150
    if (codeNum === 100 || codeNum === 150) return <Sun className='w-5 h-5 text-yellow-500' />;
    // 多云/阴天 101-104, 151-154
    if ((codeNum >= 101 && codeNum <= 104) || (codeNum >= 151 && codeNum <= 154)) return <Cloud className='w-5 h-5 text-gray-500' />;
    // 雨 300-399
    if (codeNum >= 300 && codeNum <= 399) return <CloudRain className='w-5 h-5 text-blue-500' />;
    // 雪 400-499
    if (codeNum >= 400 && codeNum <= 499) return <CloudSnow className='w-5 h-5 text-cyan-500' />;
    // 雾霾沙尘 500-515
    if (codeNum >= 500 && codeNum <= 515) return <Wind className='w-5 h-5 text-gray-400' />;
    return <Cloud className='w-5 h-5 text-gray-500' />;
  };

  // 弹窗内容
  const modalContent = (
    <>
      {/* 背景遮罩层 - 渐变动画 */}
      <div
        className={`fixed inset-0 z-[2000] transition-all duration-300 ${isAnimated ? 'bg-black/70 backdrop-blur-md' : 'bg-black/0 backdrop-blur-none'
          }`}
        onClick={handleClose}
      />

      {/* 弹窗主体 - 玻璃拟态效果 */}
      <div className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[92%] max-w-md z-[2001] transition-all duration-300 ${isAnimated ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        }`}>
        {/* 外层发光效果 */}
        <div className='absolute -inset-1 bg-gradient-to-r from-green-400 via-emerald-500 to-teal-500 rounded-3xl blur-lg opacity-30 animate-pulse' />

        {/* 主卡片 */}
        <div className='relative bg-white/95 dark:bg-gray-900/95 backdrop-blur-xl rounded-2xl shadow-2xl overflow-hidden border border-white/20'>
          {/* 顶部装饰条 */}
          <div className='h-1.5 bg-gradient-to-r from-green-400 via-emerald-500 to-teal-500' />

          {/* 顶部标题区域 */}
          <div className='relative px-6 pt-5 pb-4'>
            {/* 背景装饰 */}
            <div className='absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-green-100/50 dark:from-green-900/20 to-transparent rounded-bl-full' />

            <div className='relative flex items-center justify-between'>
              <div className='flex items-center gap-3'>
                <div className='w-10 h-10 rounded-xl bg-gradient-to-br from-green-400 to-emerald-600 flex items-center justify-center shadow-lg'>
                  <Sparkles className='w-5 h-5 text-white' />
                </div>
                <div>
                  <h2 className='text-lg font-bold bg-gradient-to-r from-green-600 to-emerald-600 bg-clip-text text-transparent'>
                    CKTV-传康播放器
                  </h2>
                  <p className='text-xs text-gray-500 dark:text-gray-400'>欢迎您的到来</p>
                </div>
              </div>
              <button
                onClick={handleClose}
                className='w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all duration-200'
                aria-label='关闭'
              >
                <X className='w-4 h-4' />
              </button>
            </div>
          </div>

          {/* 内容区域 */}
          <div className='px-6 pb-5 space-y-3'>
            {/* 位置信息卡片 */}
            <div className='bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 dark:from-blue-900/30 dark:via-indigo-900/30 dark:to-purple-900/30 rounded-xl p-4 border border-blue-100/50 dark:border-blue-800/50'>
              {loading ? (
                <div className='flex items-center justify-center py-2'>
                  <div className='w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin' />
                  <span className='ml-2 text-sm text-blue-600 dark:text-blue-400'>获取位置信息...</span>
                </div>
              ) : location ? (
                <div className='space-y-3'>
                  {/* 第一行：IP和位置 */}
                  <div className='grid grid-cols-2 gap-3'>
                    <div className='flex items-center gap-2'>
                      <div className='w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center'>
                        <Globe className='w-4 h-4 text-blue-600 dark:text-blue-400' />
                      </div>
                      <div>
                        <p className='text-[10px] text-blue-500 dark:text-blue-400 uppercase tracking-wide'>您的IP</p>
                        <p className='text-xs font-mono font-semibold text-blue-700 dark:text-blue-300'>{location.ip}</p>
                      </div>
                    </div>
                    <div className='flex items-center gap-2'>
                      <div className='w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center'>
                        <MapPin className='w-4 h-4 text-purple-600 dark:text-purple-400' />
                      </div>
                      <div>
                        <p className='text-[10px] text-purple-500 dark:text-purple-400 uppercase tracking-wide'>位置</p>
                        <p className='text-xs font-semibold text-purple-700 dark:text-purple-300'>{location.city}, {location.region}</p>
                      </div>
                    </div>
                  </div>
                  {/* 第二行：经纬度和时间 */}
                  <div className='grid grid-cols-2 gap-3'>
                    <div className='flex items-center gap-2'>
                      <div className='w-8 h-8 rounded-lg bg-teal-500/10 flex items-center justify-center'>
                        <Navigation className='w-4 h-4 text-teal-600 dark:text-teal-400' />
                      </div>
                      <div>
                        <p className='text-[10px] text-teal-500 dark:text-teal-400 uppercase tracking-wide'>经纬度</p>
                        <p className='text-xs font-mono font-semibold text-teal-700 dark:text-teal-300'>{location.lat.toFixed(2)}, {location.lon.toFixed(2)}</p>
                      </div>
                    </div>
                    <div className='flex items-center gap-2'>
                      <div className='w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center'>
                        <Clock className='w-4 h-4 text-indigo-600 dark:text-indigo-400' />
                      </div>
                      <div>
                        <p className='text-[10px] text-indigo-500 dark:text-indigo-400 uppercase tracking-wide'>时间</p>
                        <p className='text-xs font-mono font-semibold text-indigo-700 dark:text-indigo-300'>{currentTime}</p>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className='text-center text-sm text-gray-500'>位置获取失败</div>
              )}
            </div>

            {/* 天气卡片 */}
            {weather && (
              <div className='bg-gradient-to-r from-cyan-50 to-sky-50 dark:from-cyan-900/30 dark:to-sky-900/30 rounded-xl p-4 border border-cyan-100/50 dark:border-cyan-800/50'>
                <div className='flex items-center justify-between'>
                  <div className='flex items-center gap-3'>
                    <div className='w-12 h-12 rounded-xl bg-gradient-to-br from-cyan-400/20 to-sky-400/20 flex items-center justify-center'>
                      {getWeatherIcon(weather.icon)}
                    </div>
                    <div>
                      <p className='text-[10px] text-cyan-500 dark:text-cyan-400 uppercase tracking-wide'>当前天气</p>
                      <p className='text-sm font-semibold text-cyan-700 dark:text-cyan-300'>{weather.description}</p>
                    </div>
                  </div>
                  <div className='text-right'>
                    <p className='text-3xl font-bold bg-gradient-to-r from-cyan-600 to-sky-600 bg-clip-text text-transparent'>{weather.temp}°C</p>
                    <p className='text-[10px] text-cyan-500 dark:text-cyan-400'>{location?.city}</p>
                  </div>
                </div>
              </div>
            )}

            {/* 免责声明 */}
            <div className='bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 rounded-xl p-4 border border-amber-200/50 dark:border-amber-800/50'>
              <div className='flex items-start gap-3'>
                <div className='w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center flex-shrink-0 mt-0.5'>
                  <Shield className='w-4 h-4 text-amber-600 dark:text-amber-400' />
                </div>
                <div>
                  <h3 className='font-semibold text-amber-800 dark:text-amber-300 text-sm mb-1'>
                    免责声明
                  </h3>
                  <p className='text-xs text-amber-700/80 dark:text-amber-400/80 leading-relaxed'>
                    本网站仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源。
                  </p>
                </div>
              </div>
            </div>

            {/* 赞赏区域 */}
            <div className='bg-gradient-to-br from-green-50 via-emerald-50 to-teal-50 dark:from-green-900/20 dark:via-emerald-900/20 dark:to-teal-900/20 rounded-xl p-4 border border-green-200/50 dark:border-green-800/50'>
              <div className='text-center mb-3'>
                <div className='inline-flex items-center gap-2 px-3 py-1 rounded-full bg-green-100 dark:bg-green-800/50 mb-2'>
                  <Heart className='w-3.5 h-3.5 text-pink-500' />
                  <span className='text-xs font-medium text-green-700 dark:text-green-300'>传康KK 制作</span>
                </div>
                <p className='text-xs text-gray-500 dark:text-gray-400'>喜欢的朋友可以赞赏支持一下</p>
              </div>
              {/* 赞赏码 */}
              <div className='flex justify-center'>
                <div className='relative group'>
                  <div className='absolute -inset-2 bg-gradient-to-r from-green-400 to-emerald-400 rounded-2xl blur opacity-25 group-hover:opacity-40 transition-opacity' />
                  <div className='relative w-36 h-36 rounded-xl overflow-hidden shadow-xl border-2 border-white dark:border-gray-700'>
                    <img
                      src='/ck.jpg'
                      alt='传康KK的赞赏码'
                      className='w-full h-full object-cover'
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 底部按钮 */}
          <div className='px-6 pb-6'>
            <button
              onClick={handleClose}
              className='w-full py-3.5 bg-gradient-to-r from-green-500 via-emerald-500 to-teal-500 hover:from-green-600 hover:via-emerald-600 hover:to-teal-600 text-white font-semibold rounded-xl transition-all duration-300 shadow-lg shadow-green-500/25 hover:shadow-xl hover:shadow-green-500/30 active:scale-[0.98]'
            >
              <span className='flex items-center justify-center gap-2'>
                <Sparkles className='w-4 h-4' />
                开始使用
              </span>
            </button>
          </div>
        </div>
      </div>
    </>
  );

  // 只在客户端挂载后且弹窗应该显示时渲染
  if (!mounted || !isOpen) {
    return null;
  }

  // 使用Portal将弹窗渲染到body
  return createPortal(modalContent, document.body);
};
