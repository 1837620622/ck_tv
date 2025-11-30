'use client';

import { X, Globe, Clock, Sparkles, Heart, Shield } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// 欢迎弹窗组件，首次访问网站时显示免责声明和赞赏码
export const WelcomeModal: React.FC = () => {
  // 控制弹窗显示状态
  const [isOpen, setIsOpen] = useState(false);
  // 确保组件已在客户端挂载
  const [mounted, setMounted] = useState(false);
  // 用户IP地址
  const [userIP, setUserIP] = useState<string>('获取中...');
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

    // 获取用户IP地址
    const fetchIP = async () => {
      try {
        const response = await fetch('https://api.ipify.org?format=json');
        const data = await response.json();
        setUserIP(data.ip);
      } catch {
        setUserIP('无法获取');
      }
    };
    fetchIP();

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
          <div className='px-6 pb-5 space-y-4'>
            {/* IP和时间卡片 */}
            <div className='bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/30 dark:to-indigo-900/30 rounded-xl p-4 border border-blue-100/50 dark:border-blue-800/50'>
              <div className='grid grid-cols-2 gap-3'>
                <div className='flex items-center gap-2'>
                  <div className='w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center'>
                    <Globe className='w-4 h-4 text-blue-600 dark:text-blue-400' />
                  </div>
                  <div>
                    <p className='text-[10px] text-blue-500 dark:text-blue-400 uppercase tracking-wide'>您的IP</p>
                    <p className='text-sm font-mono font-semibold text-blue-700 dark:text-blue-300'>{userIP}</p>
                  </div>
                </div>
                <div className='flex items-center gap-2'>
                  <div className='w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center'>
                    <Clock className='w-4 h-4 text-indigo-600 dark:text-indigo-400' />
                  </div>
                  <div>
                    <p className='text-[10px] text-indigo-500 dark:text-indigo-400 uppercase tracking-wide'>当前时间</p>
                    <p className='text-sm font-mono font-semibold text-indigo-700 dark:text-indigo-300'>{currentTime}</p>
                  </div>
                </div>
              </div>
            </div>

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
