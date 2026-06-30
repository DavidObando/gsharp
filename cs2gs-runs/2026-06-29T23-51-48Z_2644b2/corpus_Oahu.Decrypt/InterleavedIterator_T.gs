package Oahu.Decrypt.Mpeg4.Chunks

import System
import System.Collections
import System.Collections.Generic
import System.Diagnostics.CodeAnalysis
import System.Linq
import Oahu.Decrypt.Mpeg4.Boxes

class EnumerableExtensions {
    private class InterleavedIterator[T](Enumerables []IEnumerable[T], Comparer Comparer[T]) : IEnumerable[T] {
        func GetEnumerator() IEnumerator[T] {
            let enumerators = Enumerables.Select((e IEnumerable[T]) -> e.GetEnumerator()).Select((e IEnumerator[T]) -> if e.MoveNext() { e } else { default(IEnumerator[T]?) }).ToArray()
            while GetNextValue(enumerators, out var currentIndex, out var currentEnumerator) {
                yield currentEnumerator!!.Current
                if !currentEnumerator!!.MoveNext() {
                    enumerators[currentIndex] = nil
                }
            }
        }

        private func GetEnumerator() IEnumerator -> GetEnumerator()

        private func GetNextValue(enumerators []IEnumerator[T]?, out minIndex int32, out minValue IEnumerator[T]?) bool {
            minIndex = -1
            minValue = nil
            for var i = 0; i < enumerators.Length; i++ {
                if enumerators[i] is IEnumerator[T] && (minValue == nil || Comparer.Compare(minValue!!.Current, (enumerators[i] as IEnumerator[T])!!.Current) > 0) {
                    var __decon0 = i
                    var __decon1 = (enumerators[i] as IEnumerator[T])!!
                    minIndex = __decon0
                    minValue = __decon1
                }
            }
            return minIndex != -1
        }
    }
}

func (track TrakBox) ChunkEntries() IEnumerable[ChunkEntry] -> ChunkEntryList(track)

func (source IEnumerable[TSource]) InterleaveBy[TSource, TResult, TKey IComparable[TKey]](selector (TSource) -> IEnumerable[TResult], keySelector (TResult) -> TKey) IEnumerable[TResult] {
    ArgumentNullException.ThrowIfNull(source, nameof(source))
    ArgumentNullException.ThrowIfNull(selector, nameof(selector))
    ArgumentNullException.ThrowIfNull(keySelector, nameof(keySelector))
    let comparer = Comparer[TResult].Create((x TResult, y TResult) -> keySelector(x).CompareTo(keySelector(y)))
    return InterleavedIterator[TResult](source.Select((s TSource) -> selector(s)).ToArray(), comparer!!)
}
