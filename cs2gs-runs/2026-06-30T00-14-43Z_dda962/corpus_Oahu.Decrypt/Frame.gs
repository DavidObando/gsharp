package Oahu.Decrypt.Mpeg4.ID3

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text

open class Frame(Header Header, Parent Frame) {
    open prop Size int32 -> Children.Sum((b Frame) -> b.Size)

    prop Children List[Frame] {
        get;
        init;
    }

    open prop Version uint16 -> Parent.Version

    open func Save(file Stream, version uint16) {
        Header.Render(file, Size, version)
        Render(file)
        for child in Children {
            child!!.Save(file, version)
        }
    }

    func ToString() string -> Header.ToString()
    open func Render(file Stream);

    protected func LoadChildren(file Stream, endPosition int64) {
        var origPosition = file.Position
        while file.Position < endPosition && origPosition == file.Position {
            let child = TagFactory.CreateTag(file, this, out var lengthRead)
            if child is EmptyFrame {
                break
            }
            origPosition += int64(lengthRead)
            Children.Add(child)
        }
        Header.SeekForwardToPosition(file, endPosition)
    }

    shared {
        func ReadSizeString(file Stream, unicode bool, bytes int32) string {
            let buff = [bytes]uint8
            file.ReadExactly(buff!!)
            return (if unicode { Encoding.Unicode } else { Encoding.ASCII }).GetString(buff!!)
        }

        func ReadNullTerminatedString(file Stream, unicode bool) string {
            let lst = List[uint8]()
            if unicode {
                let blob = [2]uint8
                file.ReadExactly(blob!!)
                while blob!![0] != uint8(0) || blob!![1] != uint8(0) {
                    lst.AddRange(blob!!)
                    file.ReadExactly(blob!!)
                }
                return Encoding.Unicode.GetString(lst.ToArray())
            } else {
                var b = uint8(file.ReadByte())
                while b != uint8(0) {
                    lst.Add(b)
                    b = uint8(file.ReadByte())
                }
                return Encoding.ASCII.GetString(lst.ToArray())
            }
        }

        func IsUnicode(str string) bool -> Encoding.UTF8.GetByteCount(str) != str.Length

        func UnicodeLength(str string) int32 {
            if str.Length == 0 {
                return 4
            }
            var strLen = Encoding.Unicode.GetByteCount(str)
            let c0 = str[0]
            if c0 != '￾' && c0 != '﻿' {
                strLen += 2
            }
            return strLen
        }

        func UnicodeBytes(str string) []uint8 {
            let strLen = str.Length
            if strLen == 0 {
                return Encoding.Unicode.GetPreamble()
            }
            let c0 = str[0]
            if c0 == '￾' || c0 == '﻿' {
                return Encoding.Unicode.GetBytes(str)
            } else {
                let bts = [2 * (strLen + 1)]uint8
                let preamble = Encoding.Unicode.GetPreamble()
                Array.Copy(preamble!!, bts!!, preamble!!.Length)
                Encoding.Unicode.GetBytes(str, 0, str.Length, bts!!, preamble!!.Length)
                return bts!!
            }
        }
    }
}
