package Oahu.Decrypt.Mpeg4

import System
import System.IO
import System.Text
import Oahu.Decrypt.Mpeg4.Util

open class Chapter {
    init(title string, start TimeSpan, duration TimeSpan) {
        ArgumentNullException.ThrowIfNull(title, nameof(title))
        Title = title
        StartOffset = start
        Duration = duration
        EndOffset = StartOffset + Duration
    }

    prop Title string {
        get;
        init;
    }

    prop StartOffset TimeSpan {
        get;
        init;
    }

    prop Duration TimeSpan {
        get;
        init;
    }

    prop EndOffset TimeSpan {
        get;
        init;
    }

    prop RenderSize int32 -> 2 + Encoding.UTF8.GetByteCount(Title) + Chapter.Encd.Length

    func WriteChapter(output Stream) {
        let title = Encoding.UTF8.GetBytes(Title)
        output.WriteInt16BE(int16(title.Length))
        output.Write(title)
        output.Write(Chapter.Encd)
    }

    func ToString() string {
        return "$Title {{$StartOffset - $EndOffset}}"
    }

    shared {
        private let Encd []uint8 = []uint8{uint8(0), uint8(0), uint8(0), uint8(0xc), uint8('e'), uint8('n'), uint8('c'), uint8('d'), uint8(0), uint8(0), uint8(1), uint8(0)}
    }
}
