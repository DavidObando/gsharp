package NativeSlices

import System

// A stereo frame is a value. [2]float64 would still be a CLR array reference.
struct StereoFrame {
    var Left float64
    var Right float64
}

func Gain(frames slice[StereoFrame], gain float64) {
    for var i = 0; i < frames.Length; i++ {
        frames[i].Left *= gain
        frames[i].Right *= gain
    }
}

func Fill(frames slice[StereoFrame]) {
    for var i = 0; i < frames.Length; i++ {
        frames[i] = StereoFrame{Left: 1.0, Right: 2.0}
    }
}

func Process(frames slice[StereoFrame]) {
    Fill(frames)
    Gain(frames[1..], 2.0)
    Gain(frames[1..2], 2.0)
}

func Main() {
    let frames = slice[StereoFrame].Create(64, 128)
    for var warmup = 0; warmup < 20000; warmup++ {
        Process(frames)
    }
    let before = GC.GetAllocatedBytesForCurrentThread()
    for var iteration = 0; iteration < 100000; iteration++ {
        Process(frames)
    }
    let allocated = GC.GetAllocatedBytesForCurrentThread() - before
    Console.WriteLine(frames[1].Left)
    Console.WriteLine(frames[1].Right)
    Console.WriteLine(allocated)
}
