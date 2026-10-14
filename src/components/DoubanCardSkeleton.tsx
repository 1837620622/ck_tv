import { ImagePlaceholder } from '@/components/ImagePlaceholder';

const DoubanCardSkeleton = () => {
  return (
    <div className='w-full'>
      <div className='group relative w-full rounded-lg bg-transparent shadow-none flex flex-col'>
        {/* 图片占位符 - 骨架屏效果 */}
        <ImagePlaceholder aspectRatio='aspect-[2/3]' />

        {/* 信息层骨架：放在文档流里，占位高度与真实标题一致（mt-2 + 一行 text-sm），加载完成后不会整列下跳 */}
        <div className='mt-2 flex h-5 items-center justify-center'>
          <div className='h-4 w-24 sm:w-32 bg-gray-200 dark:bg-gray-700 rounded animate-pulse'></div>
        </div>
      </div>
    </div>
  );
};

export default DoubanCardSkeleton;
