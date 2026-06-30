package Oahu.Decrypt

import System.IO
import Oahu.Decrypt.Mpeg4

interface INewSplitCallback {
    prop Chapter Chapter {
        get;
    }

    prop TrackNumber int32?
    prop TrackCount int32?
    prop TrackTitle string?
    prop OutputFile Stream?
}

interface INewSplitCallback[T INewSplitCallback[T]] : INewSplitCallback {
    shared {
        func Create(chapter Chapter) T;
    }
}

class NewSplitCallback : INewSplitCallback[NewSplitCallback] {
    private init(chapter Chapter) {
        Chapter = chapter
    }

    prop Chapter Chapter {
        get;
        init;
    }

    prop TrackNumber int32?
    prop TrackCount int32?
    prop TrackTitle string?
    prop OutputFile Stream?

    shared {
        func Create(chapter Chapter) NewSplitCallback {
            return NewSplitCallback(chapter)
        }
    }
}
