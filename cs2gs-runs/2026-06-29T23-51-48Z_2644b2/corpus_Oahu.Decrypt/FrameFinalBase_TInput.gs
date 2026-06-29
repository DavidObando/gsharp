package Oahu.Decrypt.FrameFilters

import System.Threading.Tasks

open class FrameFinalBase[TInput] : FrameFilterBase[TInput] {
    protected override func HandleInputDataAsync(input TInput) Task -> PerformFilteringAsync(input)
    protected open func PerformFilteringAsync(input TInput) Task;
}
