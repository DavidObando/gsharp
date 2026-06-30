package Oahu.Decrypt.FrameFilters.Audio

import Oahu.Decrypt.Mpeg4.Util

internal open class DashFilter : AacValidateFilter {
    init(key []?uint8) {
        Key = key
        AesCtr = if key == nil { default(AesCtr?) } else { AesCtr(key!!) }
    }

    prop Key []?uint8 {
        get;
        init;
    }

    protected open override prop InputBufferSize int32 -> 1000

    private prop AesCtr AesCtr? {
        get;
        init;
    }

    open override func PerformFiltering(input FrameEntry) FrameEntry {
        let iv []?uint8 = input.ExtraData as []uint8
        if iv != nil {
            if AesCtr == nil {
                throw NullReferenceException("AesCtr is null but the frame entry has an IV.")
            }
            let frameData = input.FrameData.Span
            AesCtr!!.Decrypt(iv, frameData, frameData)
        }
        return base.PerformFiltering(input)
    }

    protected open override func Dispose(disposing bool) {
        if disposing && !Disposed {
            AesCtr?.Dispose()
        }
        base.Dispose(disposing)
    }
}
