// <copyright file="Issue6234GenericImmutableArrayIndexerTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import System.Text
import Xunit

class Issue6234GenericImmutableArrayIndexerTests {
    @Theory
    @InlineData(`"x"`, "x")
    @InlineData("int32(42)", "42")
    func GenericImmutableArrayIndexer_VerifiesAndExecutes(value string, expected string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
import System.Collections.Immutable
shared class Probe {
    func First[T](nodes ImmutableArray[T]) T {
        return nodes[0]
    }
}
Console.Write(Probe.First(ImmutableArray.Create(` + value + `)))
`
        let program = fixture.Compile(source, "immutable-index", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(Encoding.UTF8.GetBytes(expected), fixture.RunBytes(program))
    }

    @Fact
    func GenericImmutableArrayFieldAndTemporary_VerifyAndEvaluateReceiverOnce() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let program = fixture.Compile(`import System
import System.Collections.Immutable
class Holder[T] {
    private let _nodes ImmutableArray[T]
    init(nodes ImmutableArray[T]) { _nodes = nodes }
    func First() T -> _nodes[0]
}
shared class Probe {
    var Reads int32 = 0
    func Identity[T](nodes ImmutableArray[T]) ImmutableArray[T] {
        Reads += 1
        return nodes
    }
    func First[T](nodes ImmutableArray[T]) T -> Identity(nodes)[0]
}
Console.Write(Holder[string](ImmutableArray.Create("x")).First())
Console.Write(Probe.First(ImmutableArray.Create(int32(42))))
Console.Write(Probe.Reads)
`, "immutable-receivers", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(Encoding.UTF8.GetBytes("x421"), fixture.RunBytes(program))
    }

    @Fact
    func GenericListAndDictionaryIndexers_VerifyAndExecuteWithReifiedArguments() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let program = fixture.Compile(`import System
import System.Collections.Generic
shared class Probe {
    func First[T](nodes List[T]) T -> nodes[0]
    func Find[K, V](nodes Dictionary[K, V], key K) V -> nodes[key]
}
let strings = List[string]()
strings.Add("x")
let numbers = List[int32]()
numbers.Add(42)
let lookup = Dictionary[int32, string]()
lookup.Add(7, "y")
Console.Write(Probe.First(strings))
Console.Write(Probe.First(numbers))
Console.Write(Probe.Find(lookup, 7))
`, "reference-indexers", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(Encoding.UTF8.GetBytes("x42y"), fixture.RunBytes(program))
    }

    @Fact
    func GenericMutableStructIndexer_UsesSelectedAccessorAndOriginalStorage() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = fixture.CompileCSharp(`using System;
using System.Collections;
namespace IndexerFixture;
public struct Indexed<T> : IList {
    private T value;
    public int Reads;
    public Indexed(T value) { this.value = value; Reads = 0; }
    public T this[int index] { get { Reads++; return value; } set { this.value = value; } }
    object IList.this[int index] {
        get { throw new Exception("wrong indexer"); }
        set { throw new NotSupportedException(); }
    }
    public int Count => 1;
    public bool IsReadOnly => false;
    public bool IsFixedSize => true;
    public bool IsSynchronized => false;
    public object SyncRoot => throw new NotSupportedException();
    public int Add(object value) => throw new NotSupportedException();
    public void Clear() => throw new NotSupportedException();
    public bool Contains(object value) => throw new NotSupportedException();
    public int IndexOf(object value) => throw new NotSupportedException();
    public void Insert(int index, object value) => throw new NotSupportedException();
    public void Remove(object value) => throw new NotSupportedException();
    public void RemoveAt(int index) => throw new NotSupportedException();
    public void CopyTo(Array array, int index) => throw new NotSupportedException();
    public IEnumerator GetEnumerator() => throw new NotSupportedException();
}
`, "indexed")
        let program = fixture.Compile(`import System
import IndexerFixture
shared class Probe {
    func Read[T](source Indexed[T]) int32 {
        var copy = source
        Console.Write(copy[0])
        return copy.Reads
    }
}
Console.Write(Probe.Read(Indexed[string]("x")))
`, "mutable-indexer", executable: true, "/reference:" + reference)
        IlVerifier.Verify(program, []string{reference})
        Assert.Equal(Encoding.UTF8.GetBytes("x1"), fixture.RunBytes(program))
    }
}
