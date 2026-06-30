package Oahu.Decrypt.Mpeg4.Util

import System
import System.Runtime.Intrinsics

internal class HelperExtensions {
    shared {
        private func AllLessThanOrEqual_256[T IComparable[T] unmanaged](ints Span[T], value T, out checkedcount int32) bool {
            unsafe {
                let vecSize = 256 / 8 / sizeof(T)
                let numVectors = ints.Length / vecSize
                let comparand = Vector256.Create(value)
                fixed pInts *T = ints {
                    for var i = 0; i < numVectors; i++ {
                        let intVector = Vector256.Load(pInts + vecSize * i)
                        if !Vector256.LessThanOrEqualAll(intVector, comparand) {
                            checkedcount = vecSize * i
                            return false
                        }
                    }
                }
                checkedcount = vecSize * numVectors
                return true
            }
        }

        private func AllLessThanOrEqual_512[T IComparable[T] unmanaged](ints Span[T], value T, out checkedcount int32) bool {
            unsafe {
                let vecSize = 512 / 8 / sizeof(T)
                let numVectors = ints.Length / vecSize
                let comparand = Vector512.Create(value)
                fixed pInts *T = ints {
                    for var i = 0; i < numVectors; i++ {
                        let intVector = Vector512.Load(pInts + vecSize * i)
                        if !Vector512.LessThanOrEqualAll(intVector, comparand) {
                            checkedcount = vecSize * i
                            return false
                        }
                    }
                }
                checkedcount = vecSize * numVectors
                return true
            }
        }
    }
}

func (ints Span[T]) AllLessThanOrEqual[T IComparable[T] unmanaged](value T) bool {
    unsafe {
        var checkedCount int32
        var result bool
        if Vector512.IsHardwareAccelerated {
            result = HelperExtensions.AllLessThanOrEqual_512(ints, value, &checkedCount)
        } else if Vector256.IsHardwareAccelerated {
            result = HelperExtensions.AllLessThanOrEqual_256(ints, value, &checkedCount)
        } else {
            result = true
            checkedCount = 0
        }
        if !result {
            return false
        }
        for var i = checkedCount; i < ints.Length; i++ {
            if ints[i].CompareTo(value) == 1 {
                return false
            }
        }
        return true
    }
}
