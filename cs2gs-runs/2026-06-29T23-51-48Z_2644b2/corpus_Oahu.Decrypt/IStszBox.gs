package Oahu.Decrypt.Mpeg4.Boxes

interface IStszBox : IBox {
    prop SampleCount int32 {
        get;
    }

    prop MaxSize int32 {
        get;
    }

    prop TotalSize int64 {
        get;
    }

    func GetSizeAtIndex(index int32) int32;
    func SumFirstNSizes(firstN int32) int64;

    func GetFrameSizes(firstFrameIndex uint32, numFrames uint32) ([]int32, int32) {
        let frameSizes = [int32(numFrames)]int32
        var framesSizeTotal = 0
        for var i uint32 = uint32(0); i < numFrames; i++ {
            frameSizes[i] = GetSizeAtIndex(int32((i + firstFrameIndex)))
            framesSizeTotal += frameSizes[i]
        }
        return (frameSizes, framesSizeTotal)
    }
}
