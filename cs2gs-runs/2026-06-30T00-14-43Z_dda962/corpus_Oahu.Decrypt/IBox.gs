package Oahu.Decrypt.Mpeg4.Boxes

import System
import System.Collections.Generic
import System.IO

interface IBox : IDisposable {
    prop Parent IBox? {
        get;
    }

    prop Header BoxHeader {
        get;
    }

    prop Children List[IBox] {
        get;
    }

    prop RenderSize int64 {
        get;
    }

    func Save(file Stream);
    func GetFreeBoxes() List[FreeBox];
    func GetChild[T IBox]() T?;
    func GetChildren[T IBox]() IEnumerable[T];
}
