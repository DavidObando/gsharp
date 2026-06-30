package Oahu.Decrypt.Mpeg4

import System
import System.Collections
import System.Collections.Generic
import System.Linq

open class ChapterInfo : IEnumerable[Chapter] {
    private let chapterList List[Chapter] = List[Chapter]()

    init(offsetFromBeginning TimeSpan = default(TimeSpan)) {
        StartOffset = offsetFromBeginning
    }

    prop StartOffset TimeSpan {
        get;
        init;
    }

    prop EndOffset TimeSpan -> if Count == 0 { StartOffset } else { chapterList.Max((c Chapter) -> c.EndOffset) }
    prop Chapters IReadOnlyList[Chapter] -> chapterList
    prop Count int32 -> chapterList.Count
    prop RenderSize int32 -> chapterList.Sum((c Chapter) -> c.RenderSize)

    func AddChapter(title string, duration TimeSpan) {
        let startTime = if Count == 0 { StartOffset } else { chapterList[^1].EndOffset }
        chapterList.Add(Chapter(title, startTime, duration))
    }

    func Add(title string, duration TimeSpan) -> AddChapter(title, duration)

    func GetEnumerator() IEnumerator[Chapter] {
        return chapterList.GetEnumerator()
    }

    private func GetEnumerator() IEnumerator {
        return GetEnumerator()
    }
}
