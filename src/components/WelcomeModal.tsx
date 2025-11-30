'use client';

import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// 欢迎弹窗组件，首次访问网站时显示免责声明和赞赏码
export const WelcomeModal: React.FC = () => {
  // 控制弹窗显示状态
  const [isOpen, setIsOpen] = useState(false);
  // 确保组件已在客户端挂载
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);

    // 检查是否已经显示过弹窗（使用sessionStorage，每次会话只显示一次）
    const hasShownWelcome = sessionStorage.getItem('hasShownWelcome');
    if (!hasShownWelcome) {
      setIsOpen(true);
    }
  }, []);

  // 关闭弹窗并记录状态
  const handleClose = () => {
    setIsOpen(false);
    sessionStorage.setItem('hasShownWelcome', 'true');
  };

  // 弹窗内容
  const modalContent = (
    <>
      {/* 背景遮罩层 */}
      <div
        className='fixed inset-0 bg-black/60 backdrop-blur-sm z-[2000]'
        onClick={handleClose}
      />

      {/* 弹窗主体 */}
      <div className='fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[90%] max-w-lg bg-white dark:bg-gray-900 rounded-2xl shadow-2xl z-[2001] overflow-hidden'>
        {/* 顶部标题栏 */}
        <div className='bg-gradient-to-r from-green-500 to-green-600 px-6 py-4 flex items-center justify-between'>
          <h2 className='text-xl font-bold text-white'>
            欢迎来到 CKTV-传康播放器
          </h2>
          <button
            onClick={handleClose}
            className='w-8 h-8 rounded-full flex items-center justify-center text-white/80 hover:text-white hover:bg-white/20 transition-colors'
            aria-label='关闭'
          >
            <X className='w-5 h-5' />
          </button>
        </div>

        {/* 弹窗内容区域 */}
        <div className='p-6 space-y-4'>
          {/* 免责声明 */}
          <div className='bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4'>
            <h3 className='font-semibold text-yellow-800 dark:text-yellow-300 mb-2'>
              免责声明
            </h3>
            <p className='text-sm text-yellow-700 dark:text-yellow-400 leading-relaxed'>
              本网站仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源，不对任何内容的准确性、合法性、完整性负责。
            </p>
          </div>

          {/* 作者信息 */}
          <div className='text-center'>
            <p className='text-gray-600 dark:text-gray-400 text-sm mb-3'>
              来自 <span className='font-semibold text-green-600 dark:text-green-400'>传康KK</span> 制作
            </p>
            <p className='text-gray-500 dark:text-gray-500 text-xs mb-4'>
              喜欢的朋友可以赞赏一下，感谢支持！
            </p>
          </div>

          {/* 赞赏码图片 */}
          <div className='flex justify-center'>
            <div className='w-48 h-48 rounded-lg overflow-hidden shadow-lg border-2 border-green-100 dark:border-green-800'>
              <img
                src='/ck.jpg'
                alt='传康KK的赞赏码'
                className='w-full h-full object-cover'
              />
            </div>
          </div>
        </div>

        {/* 底部按钮区域 */}
        <div className='px-6 pb-6'>
          <button
            onClick={handleClose}
            className='w-full py-3 bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white font-semibold rounded-lg transition-all duration-200 shadow-md hover:shadow-lg'
          >
            我知道了
          </button>
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
