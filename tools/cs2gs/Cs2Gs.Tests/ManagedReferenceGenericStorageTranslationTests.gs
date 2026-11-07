// <copyright file="ManagedReferenceGenericStorageTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.Linq
import Xunit

class ManagedReferenceGenericStorageTranslationTests {
    @Fact
    func ManagedReferenceObjectCreationDoesNotProjectFixedDestinationStorage() {
        const source = `using Gsharp.Values;
namespace ManagedArrayFixedObjectStorage;
public sealed class Holder<T> {
    public readonly T Value;
    public Holder(T value) { Value = value; }
}
public class Probe {
    private static readonly ManagedRef<int>[] Source = new ManagedRef<int>[1];
    private static readonly Holder<ManagedRef<int>> Field =
        new Holder<ManagedRef<int>>(Source[0]);
    private static Holder<ManagedRef<int>> Property { get; } =
        new Holder<ManagedRef<int>>(Source[0]);

    private static Holder<ManagedRef<int>> Create() =>
        new Holder<ManagedRef<int>>(Source[0]);

    private static bool IsNil(Holder<ManagedRef<int>> value) =>
        value.Value == null;

    public static bool Run() =>
        IsNil(new Holder<ManagedRef<int>>(Source[0]))
        && Field.Value == null
        && Property.Value == null
        && Create().Value == null;
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFixedObjectStorage.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed destination storage", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("Holder[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains("Holder[managed[int32]](Source[0]!!)", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(text, []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location})
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ProjectedInferredLocalKeepsCompatibleReassignmentType() {
        const source = `using Gsharp.Values;
namespace ManagedArrayCompatibleLocalReassignment;
public sealed class Holder<T> {
    public readonly T Value;
    public Holder(T value) { Value = value; }
}
public class Probe {
    private static Holder<T> Wrap<T>(T[] items) => new Holder<T>(items[0]);

    public static int Run() {
        int[] values = { 3 };
        var source = new ManagedRef<int>[1];
        source[0] = ManagedRef<int>.FromArray(values, 0);
        var holder = Wrap(source);
        holder = Wrap(source);
        return holder.Value.Borrow();
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayCompatibleLocalReassignment.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("holder.Value!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ProjectedInferredLocalRejectsIncompatibleReassignmentType() {
        const source = `using Gsharp.Values;
namespace ManagedArrayMixedLocalReassignment;
public sealed class Holder<T> {
    public readonly T Value;
    public Holder(T value) { Value = value; }
}
public class Probe {
    private static Holder<T> Wrap<T>(T[] items) => new Holder<T>(items[0]);
    private static Holder<ManagedRef<int>> Fixed(ManagedRef<int> value) =>
        new Holder<ManagedRef<int>>(value);

    public static int Run() {
        int[] values = { 3 };
        var source = new ManagedRef<int>[1];
        var holder = Wrap(source);
        holder = Fixed(ManagedRef<int>.FromArray(values, 0));
        return holder.Value.Borrow();
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayMixedLocalReassignment.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed destination storage", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("var holder Holder[managed[int32]?]", text, StringComparison.Ordinal)
    }

    @Fact
    func ProjectedInferredLocalRejectsFixedValueConsumers() {
        const source = `using Gsharp.Values;
namespace ManagedArrayFixedLocalConsumer;
public sealed class Holder<T> {
    public T Value;
}
public class Probe {
    private static Holder<ManagedRef<int>> Fixed;
    private static void Use(Holder<ManagedRef<int>> holder) { }

    public static void Pass() {
        var source = new ManagedRef<int>[1];
        var holder = new Holder<ManagedRef<int>>();
        Use(holder);
        holder.Value = source[0];
    }

    public static void Assign() {
        var source = new ManagedRef<int>[1];
        var holder = new Holder<ManagedRef<int>>();
        Fixed = holder;
        holder.Value = source[0];
    }

    public static Holder<ManagedRef<int>> Return() {
        var source = new ManagedRef<int>[1];
        var holder = new Holder<ManagedRef<int>>();
        holder.Value = source[0];
        return holder;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFixedLocalConsumer.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Equal(
            3,
            context.Diagnostics.Count(
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                    diagnostic.Message!!.Contains("fixed destination storage", StringComparison.Ordinal)
            )
        )
        Assert.DoesNotContain("var holder Holder[managed[int32]?]", text, StringComparison.Ordinal)
    }

    @Fact
    func ProjectedReceiverResolvesConstructedGenericBase() {
        const source = `using Gsharp.Values;
namespace ManagedArrayProjectedBaseReceiver;
public class Base<T> {
    public bool IsNil(T value) => value is null;
}
public sealed class Derived<T> : Base<T> {
}
public class Probe {
    private static Derived<T> Wrap<T>(T[] items) => new Derived<T>();

    public static int Run() {
        var source = new ManagedRef<int>[1];
        return Wrap(source).IsNil(source[0]) ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedBaseReceiver.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Wrap(source).IsNil(source[0])", text, StringComparison.Ordinal)
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ProjectedReceiverResolvesConstructedGenericInterface() {
        const source = `using Gsharp.Values;
namespace ManagedArrayProjectedInterfaceReceiver;
public interface IConsumer<T> {
    bool IsNil(T value) => value is null;
}
public sealed class Consumer<T> : IConsumer<T> {
}
public class Probe {
    private static IConsumer<T> Wrap<T>(T[] items) => new Consumer<T>();

    public static int Run() {
        var source = new ManagedRef<int>[1];
        return Wrap(source).IsNil(source[0]) ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedInterfaceReceiver.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Wrap(source).IsNil(source[0])", text, StringComparison.Ordinal)
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ProjectedMethodResultDoesNotChangeFixedFieldStorage() {
        const source = `using Gsharp.Values;
namespace ManagedArrayFixedMethodResult;
public sealed class Holder<T> {
    public readonly T Value;
    public Holder(T value) { Value = value; }
}
public class Probe {
    private static readonly ManagedRef<int>[] Source = new ManagedRef<int>[1];
    private static Holder<T> Wrap<T>(T[] items) => new Holder<T>(items[0]);
    private static readonly Holder<ManagedRef<int>> Field =
        Wrap<ManagedRef<int>>(Source);
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFixedMethodResult.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed destination storage", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("Wrap[managed[int32]?](Source)", text, StringComparison.Ordinal)
    }

    @Fact
    func ProjectedMethodResultDoesNotChangeFixedCollectionElementStorage() {
        const source = `using System.Collections.Generic;
using Gsharp.Values;
namespace ManagedArrayFixedCollectionElementResult;
public sealed class Holder<T> {
    public Holder(T value) { }
}
public class Probe {
    private static readonly ManagedRef<int>[] Source = new ManagedRef<int>[1];
    private static Holder<T> Wrap<T>(T[] items) => new Holder<T>(items[0]);
    private static readonly List<Holder<ManagedRef<int>>> Values = new() {
        Wrap<ManagedRef<int>>(Source)
    };
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFixedCollectionElementResult.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed destination storage", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("Wrap[managed[int32]?](Source)", text, StringComparison.Ordinal)
    }

    @Fact
    func ZeroArgumentRefExtensionReceiverIsMutable() {
        const source = `namespace ZeroArgumentRefExtension;
public readonly struct Counter {
    public int Value { get; }
    public Counter(int value) { Value = value; }
}
public static class Extensions {
    public static void Touch(this ref Counter counter) { }
}
public class Probe {
    public static int Run() {
        var counter = new Counter(42);
        counter.Touch();
        return counter.Value;
    }
}`
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ZeroArgumentRefExtension.cs", source)},
            CSharpProjectLoader.RuntimeReferences()
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity != TranslationSeverity.Info
        )
        Assert.Contains("var counter", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(text + "\nProbe.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ContainingTypeProjectionIncludesGenericOuterType() {
        const source = `using Gsharp.Values;
namespace ManagedArrayNestedContainingType;
public class Outer<T> {
    public class Inner {
        private readonly T value;
        public Inner(T[] items) { this.value = items[0]; }
        public T Get() => this.value;
    }
    public class Mid {
        public class Deep {
            public Deep(T[] items) { }
        }
    }
    public class GenericInner<U> {
        public GenericInner(T[] items, U tag) { }
    }
}
public class Probe {
    public static int Run() {
        int[] values = { 42 };
        var source = new ManagedRef<int>[1];
        _ = new Outer<ManagedRef<int>>.Inner(new ManagedRef<int>[1]);
        _ = new Outer<ManagedRef<int>>.Mid.Deep(new ManagedRef<int>[1]);
        _ = new Outer<ManagedRef<int>>.GenericInner<string>(new ManagedRef<int>[1], "ok");
        source[0] = ManagedRef<int>.FromArray(values, 0);
        var inner = new Outer<ManagedRef<int>>.Inner(source);
        return inner.Get().Borrow();
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNestedContainingType.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Outer[managed[int32]?].Inner([1]managed[int32]?)", text, StringComparison.Ordinal)
        Assert.Contains("Outer[managed[int32]?].Mid.Deep([1]managed[int32]?)", text, StringComparison.Ordinal)
        Assert.Contains(
            "Outer[managed[int32]?].GenericInner[string]([1]managed[int32]?, \"ok\")",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains("let inner = Outer[managed[int32]?].Inner(source)", text, StringComparison.Ordinal)
        Assert.Contains("inner.Get()!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func FailedOuterProjectionInvalidatesNestedCallProjection() {
        const source = `using Gsharp.Values;
namespace ManagedArrayFailedOuterProjection;
public sealed class Holder<T> {
    public bool Accept(T value) => true;
}
public class Probe {
    private static readonly Holder<ManagedRef<int>> Fixed = new();
    private static T First<T>(T[] items) => items[0];

    public static bool Run() {
        var source = new ManagedRef<int>[1];
        return Fixed.Accept(First(source));
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFailedOuterProjection.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed receiver storage", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("First[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains("First(source)", text, StringComparison.Ordinal)
    }

    @Fact
    func CapturedWriteConstrainsInferredProjectedLocalStorage() {
        const source = `using System;
using Gsharp.Values;
namespace ManagedArrayCapturedLocalWrite;
public sealed class Holder<T> {
    public Holder(T value) { }
}
public class Probe {
    public static bool Run() {
        int[] values = { 42 };
        var source = new ManagedRef<int>[1];
        var fixedValue = ManagedRef<int>.FromArray(values, 0);
        var holder = new Holder<ManagedRef<int>>(source[0]);
        Action reset = () => holder = new Holder<ManagedRef<int>>(fixedValue);
        reset();
        return holder != null;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayCapturedLocalWrite.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed destination storage", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("Holder[managed[int32]?](source[0])", text, StringComparison.Ordinal)
    }

    @Fact
    func NestedProjectionDoesNotEscapeFailedReceiverProjection() {
        const source = `using System.Collections.Generic;
using Gsharp.Values;
namespace ManagedArrayFailedReceiverProjection;
public sealed class Holder<T> {
    public T Value;
    public T Other;
    public bool Same(T other) => true;
}
public class Probe {
    private static readonly List<ManagedRef<int>> FixedList = new();

    public static bool Run() {
        var source = new ManagedRef<int>[1];
        var holder = (new Holder<List<ManagedRef<int>>>());
        holder.Value = (new List<ManagedRef<int>> { source[0] });
        holder.Other = (new List<ManagedRef<int>> { source[0] });
        holder.Value = FixedList;
        return holder.Same(FixedList);
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFailedReceiverProjection.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        Assert.DoesNotContain("List[managed[int32]?]{ source[0] }", text, StringComparison.Ordinal)
    }

    @Fact
    func FixedReceiverFailureDoesNotRetainMethodProjection() {
        const source = `using Gsharp.Values;
namespace ManagedArrayFailedReceiverMethodProjection;
public sealed class Holder<T> {
    public bool Same<U>(T first, U second) => true;
}
public class Probe {
    private static readonly Holder<ManagedRef<int>> Fixed = new();

    public static bool Run() {
        var source = new ManagedRef<int>[1];
        return Fixed.Same<ManagedRef<int>>(source[0], source[0]);
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFailedReceiverMethodProjection.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed receiver storage", StringComparison.Ordinal)
        )
        Assert.Contains("Fixed.Same[managed[int32]](source[0]!!, source[0]!!)", text, StringComparison.Ordinal)
        Assert.DoesNotContain("Fixed.Same[managed[int32]?]", text, StringComparison.Ordinal)
    }

    @Fact
    func FixedReceiverProjectionReportsStorageBeforeArgumentConflict() {
        const source = `using System.Collections.Generic;
using Gsharp.Values;
namespace ManagedArrayFixedReceiverConflict;
public sealed class Holder<T> {
    public bool Same(T first, T second) => true;
}
public class Probe {
    private static readonly Holder<List<ManagedRef<int>>> Fixed = new();

    public static bool Run() {
        var source = new ManagedRef<int>[1];
        var nullableList = new List<ManagedRef<int>> { source[0] };
        var fixedList = new List<ManagedRef<int>>();
        return Fixed.Same(nullableList, fixedList);
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFixedReceiverConflict.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let _ = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed receiver storage", StringComparison.Ordinal)
        )
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Message!!.Contains(
                "conflicting argument types",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func RepeatedGenericProjectionConflictReportsUnsupported() {
        const source = `using Gsharp.Values;
namespace ManagedArrayRepeatedGenericProjection;
public sealed class Pair<TFirst, TSecond> {
    public TFirst First;
    public TSecond Second;
}
public class Probe {
    private static void Accept<T>(Pair<T, T> pair) { }
    public static void Run() {
        int[] values = { 1 };
        var source = new ManagedRef<int>[1];
        var nonNull = ManagedRef<int>.FromArray(values, 0);
        Accept(new Pair<ManagedRef<int>, ManagedRef<int>> {
            First = nonNull,
            Second = source[0],
        });
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayRepeatedGenericProjection.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("conflicting argument types", StringComparison.Ordinal)
        )
    }

    @Fact
    func StaticGenericMemberWriteWithProjectedValueReportsUnsupported() {
        const source = `using Gsharp.Values;
namespace ManagedArrayStaticGenericMemberWrite;
public static class Holder<T> {
    public static T Value;
}
public class Probe {
    public static void Run() {
        var source = new ManagedRef<int>[1];
        Holder<ManagedRef<int>>.Value = source[0];
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayStaticGenericMemberWrite.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("generic member's fixed receiver type", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("holder.Field")
    @InlineData("holder.Property")
    func InstanceGenericMemberWriteWithProjectedValueReportsUnsupported(target string) {
        let source = (`using Gsharp.Values;
namespace ManagedArrayInstanceGenericMemberWrite;
public sealed class Holder<T> {
    public T Field;
    public T Property { get; set; }
}
public class Probe {
    public static void Set(
        Holder<ManagedRef<int>> holder,
        ManagedRef<int>[] source) {
        ` + "$target" + ` = source[0];
    }
}`)
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayInstanceGenericMemberWrite.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("generic member's fixed receiver type", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
    }

    @Fact
    func GenericMemberDefinitionAssignmentUsesProjectedContract() {
        const source = `using Gsharp.Values;
namespace ManagedArrayGenericMemberDefinitionAssignment;
public sealed class Holder<T> {
    private T value;
    public Holder(T value) { this.value = value; }
    public T Value => this.value;
}
public class Probe {
    public static int Run() {
        var source = new ManagedRef<int>[1];
        var holder = new Holder<ManagedRef<int>>(source[0]);
        return holder.Value == null ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayGenericMemberDefinitionAssignment.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ConditionalLocalsUseConvertibleProjectedCommonBase() {
        const source = `using Gsharp.Values;
namespace ManagedArrayProjectedCompositeBase;
public class Base<T> {
    public T Value;
}
public sealed class Derived<T> : Base<T> {
}
public class Probe {
    private static Base<T> WrapBase<T>(T[] source) =>
        new Base<T> { Value = source[0] };
    private static Derived<T> WrapDerived<T>(T[] source) =>
        new Derived<T> { Value = source[0] };

    public static int Run(bool flag) {
        var source = new ManagedRef<int>[1];
        var value = flag
            ? WrapDerived(source)
            : WrapBase(source);
        return value.Value == null ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedCompositeBase.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("value.Value!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(true)",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ConditionalRejectsIncompatibleInvariantProjectedArms() {
        const source = `using Gsharp.Values;
namespace ManagedArrayProjectedInvariantConditional;
public sealed class Holder<T> {
    public T Value;
}
public class Probe {
    private static Holder<T> Wrap<T>(T[] source) =>
        new Holder<T> { Value = source[0] };

    public static void Run(bool flag) {
        var source = new ManagedRef<int>[1];
        var fixedValue = new Holder<ManagedRef<int>>();
        var value = flag ? Wrap(source) : fixedValue;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedInvariantConditional.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("incompatible managed-reference projections", StringComparison.Ordinal)
        )
    }

    @Fact
    func ConditionalRejectsCovariantProjectedArgumentErasure() {
        const source = `using System.Collections.Generic;
using Gsharp.Values;
namespace ManagedArrayProjectedCovariantConditional;
public class Probe {
    private static List<T> Wrap<T>(T[] source) =>
        new List<T> { source[0] };

    public static IEnumerable<object> Run(bool flag) {
        var source = new ManagedRef<int>[1];
        var selected = flag
            ? Wrap(source)
            : (IEnumerable<object>)new List<object>();
        return selected;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedCovariantConditional.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("incompatible managed-reference projections", StringComparison.Ordinal)
        )
    }

    @Fact
    func ConditionalRejectsManagedReferenceIdentityErasureThroughCovariance() {
        const source = `using Gsharp.Values;
namespace ManagedArrayProjectedFixedCovariantArgument;
public interface IProducer<out T> {
}
public sealed class Box<T> : IProducer<ManagedRef<int>> {
}
public sealed class ObjectProducer : IProducer<object> {
}
public class Probe {
    private static Box<T> Wrap<T>(T[] source) => new Box<T>();

    public static void Run(bool flag) {
        var source = new ManagedRef<int>[1];
        var selected = flag
            ? Wrap(source)
            : (IProducer<object>)new ObjectProducer();
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedFixedCovariantArgument.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("incompatible managed-reference projections", StringComparison.Ordinal)
        )
    }

    @Fact
    func ConditionalAllowsOrdinaryCovariantObjectConversion() {
        const source = `using Gsharp.Values;
namespace OrdinaryProjectedCovariantArgument;
public interface IProducer<out T> {
    int Value { get; }
}
public sealed class Box<T> : IProducer<string> {
    public int Value => 42;
}
public sealed class ObjectProducer : IProducer<object> {
    public int Value => 42;
}
public class Probe {
    private static Box<T> Wrap<T>(T[] source) => new Box<T>();

    public static int Run(bool flag) {
        var source = new ManagedRef<int>[1];
        var selected = flag
            ? Wrap(source)
            : (IProducer<object>)new ObjectProducer();
        return selected.Value;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("OrdinaryProjectedCovariantArgument.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(true)",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ConditionalKeepsSafeContravariantCommonType() {
        const source = `using Gsharp.Values;
namespace ManagedArrayProjectedContravariantConditional;
public interface IConsumer<in T> {
    int Consume(T value);
}
public sealed class Consumer<T> : IConsumer<T> {
    public int Consume(T value) => 42;
}
public sealed class ObjectConsumer : IConsumer<object> {
    public int Consume(object value) => 42;
}
public class Probe {
    private static IConsumer<T> Wrap<T>(T[] source) =>
        new Consumer<T>();

    public static int Run(bool flag) {
        var source = new ManagedRef<int>[1];
        IConsumer<object> fallback = new ObjectConsumer();
        var selected = flag ? Wrap(source) : fallback;
        var storage = new int[1];
        return selected.Consume(ManagedRef<int>.FromArray(storage, 0));
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedContravariantConditional.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("cast[IConsumer[managed[int32]]](fallback)", text, StringComparison.Ordinal)
        Assert.DoesNotContain("cast[IConsumer[managed[int32]?]](fallback)", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(false)",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ConditionalAllowsVarianceWithSameProjectedArgument() {
        const source = `using System.Collections.Generic;
using System.Linq;
using Gsharp.Values;
namespace ManagedArrayProjectedVariantControl;
public class Probe {
    private static List<T> WrapList<T>(T[] source) =>
        new List<T> { source[0] };
    private static IEnumerable<T> WrapSequence<T>(T[] source) =>
        new List<T> { source[0] };

    public static int Run(bool flag) {
        var source = new ManagedRef<int>[1];
        var selected = flag
            ? WrapList(source)
            : WrapSequence(source);
        return selected.Count() == 1 ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedVariantControl.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(true)",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ImportedStaticGenericMemberWriteWithProjectedValueReportsUnsupported() {
        const source = `using Gsharp.Values;
using static ManagedArrayImportedStaticGenericMemberWrite.Holder<Gsharp.Values.ManagedRef<int>>;
namespace ManagedArrayImportedStaticGenericMemberWrite;
public static class Holder<T> {
    public static T Value;
}
public class Probe {
    public static void Run() {
        var source = new ManagedRef<int>[1];
        Value = source[0];
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayImportedStaticGenericMemberWrite.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("generic member's fixed receiver type", StringComparison.Ordinal)
        )
    }

    @Fact
    func ProjectedConditionalLocalValidatesLaterFixedAssignment() {
        const source = `using Gsharp.Values;
namespace ManagedArrayProjectedConditionalLocalAssignment;
public sealed class Holder<T> {
    public Holder(T value) { Value = value; }
    public T Value { get; }
}
public class Probe {
    private static Holder<T> Wrap<T>(T[] source) =>
        new Holder<T>(source[0]);
    private static Holder<ManagedRef<int>> Fixed(ManagedRef<int> value) =>
        new Holder<ManagedRef<int>>(value);

    public static void Run(bool flag) {
        int[] values = { 42 };
        var source = new ManagedRef<int>[1];
        var projected = flag ? Wrap(source) : Wrap(source);
        projected = Fixed(ManagedRef<int>.FromArray(values, 0));
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedConditionalLocalAssignment.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("conflicts with a later assignment or consumer", StringComparison.Ordinal)
        )
    }

    @Fact
    func NestedGenericFieldReassignmentRemainsFixedStorage() {
        const source = `using Gsharp.Values;
namespace ManagedArrayNestedGenericFieldReassignment;
public sealed class Holder<T> {
}
public class Probe {
    private static Holder<ManagedRef<int>>[] Values =
        new Holder<ManagedRef<int>>[0];

    private static T[] Produce<T>() => new T[1];

    public static int Run() {
        Values = Produce<Holder<ManagedRef<int>>>();
        return 42;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNestedGenericFieldReassignment.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed destination storage", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("Produce[Holder[managed[int32]?]]()", text, StringComparison.Ordinal)
    }

    @Fact
    func ProjectedConstructionAllowsExplicitReferenceConversions() {
        const source = `using Gsharp.Values;
namespace ManagedArrayProjectedConstructionConversions;
public interface IMarker { }
public class Base { }
public sealed class Derived<T> : Base, IMarker {
    public Derived(T value) { }
}
public class Probe {
    public static int Run() {
        var source = new ManagedRef<int>[1];
        Base asBase = new Derived<ManagedRef<int>>(source[0]);
        IMarker asInterface = new Derived<ManagedRef<int>>(source[0]);
        object asObject = new Derived<ManagedRef<int>>(source[0]);
        return asBase != null
            && asInterface != null
            && asObject != null ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedConstructionConversions.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Equal(3, text.Split("Derived[managed[int32]?](source[0])").Length - 1)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NullableAsyncLocalValueWriteOfLiteralTranslatesWithoutDiagnostic() {
        let (_, context) = TranslatePlain(`#nullable enable
using System.Threading;
namespace Plain4525B;
public class Probe {
    public static void Run(AsyncLocal<string?> s) {
        s.Value = "x";
    }
}`)
        Assert.Empty(context.Diagnostics)
    }

    @Fact
    func GenericStorageWriteOfNullableStringForgivesInsteadOfRejecting() {
        let (text, context) = TranslatePlain(`#nullable enable
namespace Plain4525C;
public sealed class Holder<T> { public T Field = default!; }
public class Probe {
    public static void Run(Holder<string> holder, string? nullableString) {
        holder.Field = nullableString;
    }
}`)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId != CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
        )
        Assert.Single(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId &&
                d.Message!!.StartsWith(
                "kind=constructed-generic-member | target=Holder<string>.Field",
                StringComparison.Ordinal
            )
        )
        Assert.Contains("nullableString!!", text, StringComparison.Ordinal)
    }

    @Fact
    func NonGenericDerivedReceiverProjectsInheritedGenericBaseMembers() {
        const source = `using System;
using System.Linq;
using Gsharp.Values;
namespace ManagedArrayInheritedGenericBase;
public interface IMarker { }
public interface ISelf<U> where U : ISelf<U> { }
public class SelfNode : ISelf<SelfNode> { }
public class Box<T> {
    private readonly T item;
    public Box() { }
    public Box(T[] items) { this.item = items[0]; }
    public T Get() => this.item;
}
public class Wrapper<TFirst, TSecond> {
    public void UseFirst(TFirst value) { }
    public void UseSecond(TSecond value) { }
}
public class Base<T> {
    private T stored;
    public byte Flag;
    public T Value;
    public Box<T>? ValueBox;
    public Func<Box<T>> Factory = () => new Box<T>();
    public Wrapper<T, ManagedRef<int>> Data = new();
    public void Add(T value) {
        this.stored = value;
        this.ValueBox = new Box<T>(new[] { value });
    }
    public int AddAndReturn(T value) {
        this.Add(value);
        return 0;
    }
    public T Get() => this.stored;
    public Box<T> GetBox() => this.ValueBox!;
    public void OutBox(out Box<T> box) => box = this.ValueBox!;
    public (Box<T>, int) Pair() => (this.ValueBox!, 7);
    public void UseConstrained<U>(U box) where U : Box<T> { }
    public void UseSelf<U>(U value) where U : ISelf<U> { }
    public string Describe() => "ok";
    public void AcceptObject(object value) { }
    public U Echo<U>(U value) => value;
    public T Id<U>(T value, U tag) => value;
    public T this[T key] {
        get => this.stored;
        set { this.stored = value; }
    }
}
public class ParamsIndexerBase<T> {
    private T stored;
    public T this[params T[] keys] {
        get => this.stored;
        set { this.stored = value; }
    }
}
public class ParamsIndexerDerived : ParamsIndexerBase<ManagedRef<int>> { }
public class PatternBeforeCallerDerived : Base<ManagedRef<int>> { }
public class QueryBeforeCallerDerived : Base<ManagedRef<int>> { }
public class OutVarDerived : Base<ManagedRef<int>> { }
public class SelfConstrainedMethodDerived : Base<ManagedRef<int>> { }
public class DeclPatternNonNullDerived : Base<ManagedRef<int>> { }
public class InferredDeconstructDerived : Base<ManagedRef<int>> { }
public class InferredDeconstructConsumerDerived : Base<ManagedRef<int>> { }
public class MethodGroupAssignDerived : Base<ManagedRef<int>> { }
public class Derived : Base<ManagedRef<int>> {
    public void BaseAdd(ManagedRef<int>[] items) => base.Add(items[0]);
    public int BaseRead() => base.Get().Borrow();
}
public class SubDerived : Derived { }
public class NestedCallDerived : Base<ManagedRef<int>> { }
public class MarkerDerived : Base<ManagedRef<int>>, IMarker { }
public class ImplicitAssignDerived : Base<Box<ManagedRef<int>>> {
    public void Assign(ManagedRef<int>[] items) {
        Value = new Box<ManagedRef<int>>(items);
    }
}
public class GenericDerived<T> : Base<T> { }
public class OpenDerived<U> : Base<ManagedRef<U>> { }
public class TupleDerived<U> : Base<(ManagedRef<U> Reference, U Value)> { }
public class Probe {
    private static ref int GetRef(int[] storage, object? ignored) => ref storage[0];
    private static void AcceptNonNullScalar(ManagedRef<int> value) { }
    private static int ReadConstrained<U>(U item) where U : SubDerived => item.Get().Borrow();

    public static int Run() {
        var emptySource = new ManagedRef<int>[1];
        if (emptySource is [var patternItem]) {
            new PatternBeforeCallerDerived().Add(patternItem);
        }
        _ = (from queryItem in emptySource select new QueryBeforeCallerDerived().AddAndReturn(queryItem)).Count();
        var selfDerived = new SelfConstrainedMethodDerived();
        selfDerived.UseSelf(new SelfNode());
        selfDerived.Add(emptySource[0]);
        var derived = new Derived();
        derived.Flag = 0;
        derived.BaseAdd(emptySource);
        derived.UseConstrained(new Box<ManagedRef<int>>(emptySource));
        derived.Data.UseFirst(emptySource[0]);
        derived[emptySource[0]] = emptySource[0];
        _ = derived[emptySource[0]];
        var paramsDerived = new ParamsIndexerDerived();
        paramsDerived[emptySource[0]] = emptySource[0];
        _ = paramsDerived[emptySource[0]];
        new SubDerived().Add(emptySource[0]);
        new NestedCallDerived().Add(new NestedCallDerived().Id<int>(emptySource[0], 0));
        IMarker marker = new MarkerDerived();
        new MarkerDerived().Add(emptySource[0]);
        new ImplicitAssignDerived().Assign(emptySource);
        new GenericDerived<ManagedRef<int>>().Add(emptySource[0]);
        var genericLocal = new GenericDerived<ManagedRef<int>>();
        genericLocal.Add(emptySource[0]);
        new OpenDerived<int>().Add(emptySource[0]);
        var emptyLongSource = new ManagedRef<long>[1];
        new OpenDerived<long>().Add(emptyLongSource[0]);
        var emptyTuples = new (ManagedRef<int> Reference, int Value)[1];
        new TupleDerived<int>().Add(emptyTuples[0]);

        int[] values = { 20, 22 };
        var populatedSource = new ManagedRef<int>[1];
        populatedSource[0] = ManagedRef<int>.FromArray(values, 0);
        var populated = new SubDerived();
        Func<object> describeReader = populated.Describe;
        Action<string> objectWriter = populated.AcceptObject;
        _ = describeReader();
        objectWriter("test");
        populated.Add(populatedSource[0]);
        ref int alias = ref GetRef(values, populated.Get());
        _ = alias;
        SubDerived? nullablePopulated = populated;
        var nestedConditional = nullablePopulated?.ValueBox?.Get().Borrow() ?? 0;
        _ = (nullablePopulated?.Pair()).HasValue;
        _ = (nullablePopulated?.Pair()).Value.Item1.Get().Borrow();
        var inferredDeconstruct = new InferredDeconstructDerived();
        inferredDeconstruct.Add(populatedSource[0]);
        var (inferredBox, _) = inferredDeconstruct.Pair();
        _ = inferredBox.Get().Borrow();
        new InferredDeconstructConsumerDerived().UseConstrained(inferredBox);
        var mgAssign = new MethodGroupAssignDerived();
        mgAssign.Factory = mgAssign.GetBox;
        mgAssign.Add(populatedSource[0]);
        _ = mgAssign.Factory().Get().Borrow();
        var outVarDerived = new OutVarDerived();
        outVarDerived.Add(populatedSource[0]);
        outVarDerived.OutBox(out var outProjectedBox);
        _ = outProjectedBox.Get().Borrow();
        if (populatedSource[0] is ManagedRef<int> declNonNullItem) {
            AcceptNonNullScalar(declNonNullItem);
            new DeclPatternNonNullDerived().Add(declNonNullItem);
        }
        var secondSource = new ManagedRef<int>[1];
        secondSource[0] = ManagedRef<int>.FromArray(values, 1);
        return (ReadConstrained(populated) - nestedConditional) + populated.BaseRead() + populated.Echo(secondSource[0]).Borrow();
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayInheritedGenericBase.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("open class Derived : Base[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains("open class PatternBeforeCallerDerived : Base[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains("open class QueryBeforeCallerDerived : Base[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains("open class OutVarDerived : Base[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains(
            "open class SelfConstrainedMethodDerived : Base[managed[int32]?]",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains("open class DeclPatternNonNullDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class InferredDeconstructDerived : Base[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains(
            "open class InferredDeconstructConsumerDerived : Base[managed[int32]?]",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains("open class MethodGroupAssignDerived : Base[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains(
            "open class ParamsIndexerDerived : ParamsIndexerBase[managed[int32]?]",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains("open class SubDerived : Derived", text, StringComparison.Ordinal)
        Assert.Contains("open class NestedCallDerived : Base[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains("open class MarkerDerived : Base[managed[int32]?], IMarker", text, StringComparison.Ordinal)
        Assert.Contains("open class ImplicitAssignDerived : Base[Box[managed[int32]?]]", text, StringComparison.Ordinal)
        Assert.Contains("open class OpenDerived[U] : Base[managed[U]?]", text, StringComparison.Ordinal)
        Assert.Contains(
            "open class TupleDerived[U] : Base[(Reference managed[U]?, Value U)]",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains("base.Add(items[0])", text, StringComparison.Ordinal)
        Assert.Contains("base.Get()!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("item.Get()!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("derived.UseConstrained(Box[managed[int32]?](emptySource))", text, StringComparison.Ordinal)
        Assert.Contains("derived.Data.UseFirst(emptySource[0])", text, StringComparison.Ordinal)
        Assert.Contains("derived[emptySource[0]] = emptySource[0]", text, StringComparison.Ordinal)
        Assert.Contains("_ = derived[emptySource[0]]", text, StringComparison.Ordinal)
        Assert.Contains("paramsDerived[emptySource[0]] = emptySource[0]", text, StringComparison.Ordinal)
        Assert.Contains("_ = paramsDerived[emptySource[0]]", text, StringComparison.Ordinal)
        Assert.Contains("SubDerived().Add(emptySource[0])", text, StringComparison.Ordinal)
        Assert.Contains(
            "NestedCallDerived().Add(NestedCallDerived().Id[int32](emptySource[0], 0))",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains("GenericDerived[managed[int32]?]().Add(emptySource[0])", text, StringComparison.Ordinal)
        Assert.Contains("OpenDerived[int32]().Add(emptySource[0])", text, StringComparison.Ordinal)
        Assert.Contains("OpenDerived[int64]().Add(emptyLongSource[0])", text, StringComparison.Ordinal)
        Assert.Contains("TupleDerived[int32]().Add(emptyTuples[0])", text, StringComparison.Ordinal)
        Assert.DoesNotContain("emptySource[0]!!", text, StringComparison.Ordinal)
        Assert.Contains("nullablePopulated?.ValueBox?.Get()!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("populated.Echo(secondSource[0])!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NonGenericDerivedReceiverRejectsFixedBaseConversionWhenProjected() {
        const source = `using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Gsharp.Values;
namespace ManagedArrayInheritedGenericBaseFixedDestination;
public interface IStore<T> {
    void Replace(ref T value);
}
public interface IFixedProperty {
    ManagedRef<int> PropValue { get; set; }
}
public class SelfNode<T> where T : SelfNode<T> {
    public object BoxValue(T value) => value;
}
public class Box<T> {
    public Box() { }
    public Box(T[] items) { }
    public void Add(T value) { }
    public Box<T> Next() => this;
}
public class Holder<T> {
    public Box<T> Value = new();
}
public class Wrapper<TFirst, TSecond> {
    public void UseFirst(TFirst value) { }
    public void UseSecond(TSecond value) { }
}
public class CollectionBase<T> : IEnumerable<Box<T>> {
    public void Add(Box<T> item) { }
    public void AddScalar(T value) { }
    public IEnumerator<Box<T>> GetEnumerator() => null!;
    System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => null!;
}
public class NamedIndexerBase<T> {
    public void Add(T value) { }
    public int this[int index, Box<T> key] => 0;
}
public static class BoxExtensions {
    public static void Ignore<U>(this Box<ManagedRef<int>> box, U tag) { }
}
public class Base<T> {
    public T ScalarValue;
    public Box<T> Value = new();
    public Box<T>? NullableBox;
    public Holder<T> NestedHolder = new();
    public Wrapper<T, ManagedRef<int>> Data = new();
    public T PropValue { get; set; }
    public virtual event Action<T> Changed;
    public event Action<Box<T>> BoxChanged;
    public Action<Box<T>> Callback = _ => { };
    public Func<Box<T>> Factory = () => new Box<T>();
    public Base() { }
    public Base(ref T value) { }
    public virtual void Add(T value) { }
    public void Use(Box<T> box) { }
    public void UseConstrained<U>(U box) where U : Box<T> { }
    public void Replace(ref T value) { }
    public void OutBox(out Box<T> box) => box = this.Value;
    public T Get() => default;
    public (Box<T>, int) Pair() => (this.Value, 0);
    public Task<Box<T>> GetAsync() => Task.FromResult(this.Value);
    public int this[Box<T> key] {
        get => 0;
        set { }
    }
}
public class ConstrainedPairBase<T, U> where U : Box<T> {
    public void Add(T value) { }
}
public class Mid<U> : Base<U> { }
public class Derived : Base<ManagedRef<int>> { }
public class ConditionalDerived : Base<ManagedRef<int>> { }
public class SwitchDerived : Base<ManagedRef<int>> { }
public class BoxDerived : Base<ManagedRef<int>> { }
public class ByRefCtorDerived : Base<ManagedRef<int>> {
    public ByRefCtorDerived(ref ManagedRef<int> value) : base(ref value) { }
}
public class PrimaryByRefCtorDerived(ref ManagedRef<int> value) : Base<ManagedRef<int>>(ref value);
public class ListCovariantDerived : Base<ManagedRef<int>> { }
public class ArrayCovariantDerived : Base<ManagedRef<int>> { }
public class OwnGenericDerived<U> : Base<ManagedRef<int>> {
    public void Own(U value) { }
}
public class FixedMemberDerived : Base<ManagedRef<int>> {
    public Box<ManagedRef<int>> Fixed = new();
    public void CallImplicitFixed(ManagedRef<int>[] items) => Fixed.Add(items[0]);
}
public class OverrideParentDerived : Base<ManagedRef<int>> { }
public class OverrideChildDerived : OverrideParentDerived {
    public override void Add(ManagedRef<int> value) { }
}
public class EventOverrideParentDerived : Base<ManagedRef<int>> { }
public class EventOverrideChildDerived : EventOverrideParentDerived {
    public override event Action<ManagedRef<int>> Changed;
}
public class InterfaceDerived : Base<ManagedRef<int>>, IStore<ManagedRef<int>> { }
public class InterfacePropertyDerived : Base<ManagedRef<int>>, IFixedProperty { }
public class MethodGroupDerived : Base<ManagedRef<int>> { }
public class IndexerDerived : Base<ManagedRef<int>> { }
public class MultiLevelBoxDerived : Mid<ManagedRef<int>> { }
public class LambdaMemberDerived : Base<ManagedRef<int>> { }
public class MemberReadDerived : Base<ManagedRef<int>> { }
public class ConditionalAccessDerived : Base<ManagedRef<int>> { }
public class RefLocalDerived : Base<ManagedRef<int>> { }
public class RefReturnDerived : Base<ManagedRef<int>> { }
public class EventSubDerived : Base<ManagedRef<int>> { }
public class ImplicitIndexerInitDerived : Base<ManagedRef<int>> { }
public class LambdaParamDerived : Base<ManagedRef<int>> { }
public class PartialWrapperDerived : Base<ManagedRef<int>> { }
public class ChainedReadDerived : Base<ManagedRef<int>> { }
public class CollectionExprDerived : CollectionBase<ManagedRef<int>> { }
public class CoalesceAssignDerived : Base<ManagedRef<int>> { }
public class ConstrainedDerived : Base<ManagedRef<int>> { }
public class ForEachDerived : CollectionBase<ManagedRef<int>> { }
public class NamedIndexerDerived : NamedIndexerBase<ManagedRef<int>> { }
public class ValueAssignDerived : Base<ManagedRef<int>> { }
public class GenericExtDerived : Base<ManagedRef<int>> { }
public class DelegateCallDerived : Base<ManagedRef<int>> { }
public class ConstraintInstantiationDerived : Base<ManagedRef<int>> { }
public class AwaitDerived : Base<ManagedRef<int>> { }
public class PatternDerived : Base<ManagedRef<int>> { }
public class SuppressDerived : Base<ManagedRef<int>> { }
public class CrossProjectDerived : Base<ManagedRef<int>> { }
public class NestedConstraintInstantiationDerived : Base<ManagedRef<int>> { }
public class MethodConstraintDerived : Base<ManagedRef<int>> { }
public class SwitchPatternDerived : Base<ManagedRef<int>> { }
public class CoalesceValueDerived : Base<ManagedRef<int>> { }
public class ConstrainedPairDerived : ConstrainedPairBase<ManagedRef<int>, Box<ManagedRef<int>>> { }
public class NestedConditionalDerived : Base<ManagedRef<int>> { }
public class DeconstructDerived : Base<ManagedRef<int>> { }
public class LiftedTupleDerived : Base<ManagedRef<int>> { }
public class InferredDeconstructFixedDerived : Base<ManagedRef<int>> { }
public class UnderscoreLocalDeconstructDerived : Base<ManagedRef<int>> { }
public class FixedMethodGroupTargetDerived : Base<ManagedRef<int>> { }
public class OutVarFixedDerived : Base<ManagedRef<int>> { }
public class Probe {
    private static readonly Box<ManagedRef<int>> FixedBox = new();
    private static readonly Action<Box<ManagedRef<int>>> FixedHandler = _ => { };
    private static Box<ManagedRef<int>> FixedGetBox() => FixedBox;
    private static void AcceptFixed(Base<ManagedRef<int>> value) { }
    private static void AcceptBox(Box<ManagedRef<int>> value) { }
    private static void RequireBase<T>() where T : Base<ManagedRef<int>> { }
    private static void RequireBaseEnumerable<U>() where U : IEnumerable<Base<ManagedRef<int>>> { }
    private static ref ManagedRef<int> BorrowScalar(RefReturnDerived value) => ref value.ScalarValue;
    private static void ReadConstrainedBox<U>(U item) where U : ConstrainedDerived => AcceptBox(item.Value);

    private static void RunUnderscoreDeconstruct(ManagedRef<int>[] source, Box<ManagedRef<int>> _) {
        var underscoreDeconstruct = new UnderscoreLocalDeconstructDerived();
        int ignoredCount;
        (_, ignoredCount) = underscoreDeconstruct.Pair();
        underscoreDeconstruct.Add(source[0]);
    }

    private static async Task RunAsync(ManagedRef<int>[] source) {
        var awaitDerived = new AwaitDerived();
        AcceptBox(await awaitDerived.GetAsync());
        awaitDerived.Add(source[0]);
    }

    public static void Run(
        bool flag,
        string? nullableText,
        ref ManagedRef<int> nonNullRef,
        OwnGenericDerived<ManagedRef<int>> ownDerived
    ) {
        _ = nullableText?.Trim().Length;
        var source = new ManagedRef<int>[1];
        var derived = new Derived();
        AcceptFixed(derived);
        derived.Add(source[0]);

        Base<ManagedRef<int>> conditionalFixed = flag
            ? new ConditionalDerived()
            : new Base<ManagedRef<int>>();
        new ConditionalDerived().Add(source[0]);

        Base<ManagedRef<int>> switchFixed = flag switch {
            true => new SwitchDerived(),
            false => new Base<ManagedRef<int>>(),
        };
        new SwitchDerived().Add(source[0]);

        var boxDerived = new BoxDerived();
        boxDerived.Add(source[0]);
        boxDerived.Use(FixedBox);

        var byRefCtorDerived = new ByRefCtorDerived(ref nonNullRef);
        byRefCtorDerived.Add(source[0]);

        var primaryByRefDerived = new PrimaryByRefCtorDerived(ref nonNullRef);
        primaryByRefDerived.Add(source[0]);

        IEnumerable<Base<ManagedRef<int>>> listView = new List<ListCovariantDerived>();
        new ListCovariantDerived().Add(source[0]);

        Base<ManagedRef<int>>[] arrayView = new ArrayCovariantDerived[1];
        new ArrayCovariantDerived().Add(source[0]);

        ownDerived.Add(source[0]);
        ownDerived.Own(source[0]);

        var fixedMember = new FixedMemberDerived();
        fixedMember.Add(source[0]);
        fixedMember.Fixed = new Box<ManagedRef<int>>(source);
        fixedMember.Fixed.Add(source[0]);
        fixedMember.CallImplicitFixed(source);

        new OverrideParentDerived().Add(source[0]);

        new EventOverrideParentDerived().Add(source[0]);

        new InterfaceDerived().Add(source[0]);

        new InterfacePropertyDerived().Add(source[0]);

        var methodGroupDerived = new MethodGroupDerived();
        Func<ManagedRef<int>> reader = methodGroupDerived.Get;
        methodGroupDerived.Add(source[0]);

        var indexerDerived = new IndexerDerived();
        _ = indexerDerived[FixedBox];
        indexerDerived.Add(source[0]);

        var multiLevel = new MultiLevelBoxDerived();
        multiLevel.Add(source[0]);
        multiLevel.Use(FixedBox);

        var lambdaMember = new LambdaMemberDerived { Factory = () => FixedBox };
        lambdaMember.Add(source[0]);

        var memberRead = new MemberReadDerived();
        AcceptBox(memberRead.Value);
        memberRead.Add(source[0]);

        ConditionalAccessDerived conditionalAccess = new();
        conditionalAccess?.Use(FixedBox);
        conditionalAccess.Add(source[0]);

        var refLocalDerived = new RefLocalDerived();
        ref ManagedRef<int> alias = ref refLocalDerived.ScalarValue;
        refLocalDerived.Add(source[0]);

        var refReturnDerived = new RefReturnDerived();
        _ = BorrowScalar(refReturnDerived);
        refReturnDerived.Add(source[0]);

        var eventSubDerived = new EventSubDerived();
        eventSubDerived.BoxChanged += FixedHandler;
        eventSubDerived.Add(source[0]);

        var implicitIndexerInit = new ImplicitIndexerInitDerived { [FixedBox] = 0 };
        implicitIndexerInit.Add(source[0]);

        var lambdaParamDerived = new LambdaParamDerived();
        lambdaParamDerived.Callback = box => { };
        lambdaParamDerived.Add(source[0]);

        var partialWrapper = new PartialWrapperDerived();
        partialWrapper.Add(source[0]);
        partialWrapper.Data.UseSecond(source[0]);

        var chainedRead = new ChainedReadDerived();
        AcceptBox(chainedRead.NestedHolder.Value);
        chainedRead.Add(source[0]);

        CollectionExprDerived collectionExpr = [FixedBox];
        collectionExpr.AddScalar(source[0]);

        var coalesceAssign = new CoalesceAssignDerived();
        coalesceAssign.Add(source[0]);
        coalesceAssign.NullableBox ??= FixedBox;

        var constrained = new ConstrainedDerived();
        ReadConstrainedBox(constrained);
        constrained.Add(source[0]);

        var forEachDerived = new ForEachDerived();
        foreach (var box in forEachDerived) {
            AcceptBox(box);
        }
        forEachDerived.AddScalar(source[0]);

        var namedIndexer = new NamedIndexerDerived();
        _ = namedIndexer[key: FixedBox, index: 0];
        namedIndexer.Add(source[0]);

        var valueAssign = new ValueAssignDerived();
        AcceptBox(valueAssign.Value = new Box<ManagedRef<int>>(source));

        var genericExt = new GenericExtDerived();
        genericExt.Add(source[0]);
        genericExt.Value.Ignore(0);

        var delegateCall = new DelegateCallDerived();
        delegateCall.Callback(FixedBox);
        delegateCall.Add(source[0]);

        RequireBase<ConstraintInstantiationDerived>();
        new ConstraintInstantiationDerived().Add(source[0]);

        _ = RunAsync(source);

        var patternDerived = new PatternDerived();
        if (patternDerived is { Value: var patternBox }) {
            AcceptBox(patternBox);
        }
        patternDerived.Add(source[0]);

        var suppressDerived = new SuppressDerived();
        suppressDerived.Add(source[0]);
        AcceptBox(suppressDerived.Value!);

        new CrossProjectDerived().Add(source[0]);

        RequireBaseEnumerable<List<NestedConstraintInstantiationDerived>>();
        new NestedConstraintInstantiationDerived().Add(source[0]);

        var methodConstraintDerived = new MethodConstraintDerived();
        methodConstraintDerived.UseConstrained<Box<ManagedRef<int>>>(FixedBox);
        methodConstraintDerived.Add(source[0]);

        var switchPatternDerived = new SwitchPatternDerived();
        switch (switchPatternDerived.Value) {
            case var switchBox:
                AcceptBox(switchBox);
                break;
        }
        switchPatternDerived.Add(source[0]);

        var coalesceValueDerived = new CoalesceValueDerived();
        coalesceValueDerived.Add(source[0]);
        AcceptBox(coalesceValueDerived.NullableBox ?? FixedBox);

        new ConstrainedPairDerived().Add(source[0]);

        NestedConditionalDerived? nestedCondDerived = new();
        AcceptBox(nestedCondDerived?.NullableBox?.Next());
        nestedCondDerived.Add(source[0]);

        var deconstructDerived = new DeconstructDerived();
        Box<ManagedRef<int>> deconstructedBox;
        (deconstructedBox, _) = deconstructDerived.Pair();
        deconstructDerived.Add(source[0]);

        LiftedTupleDerived? liftedTupleDerived = new();
        AcceptBox((liftedTupleDerived?.Pair())!.Value.Item1);
        liftedTupleDerived.Add(source[0]);

        var inferredDeconstructFixed = new InferredDeconstructFixedDerived();
        var (inferredFixedBox, _) = inferredDeconstructFixed.Pair();
        AcceptBox(inferredFixedBox);
        inferredDeconstructFixed.Add(source[0]);

        RunUnderscoreDeconstruct(source, FixedBox);

        var fixedMgTarget = new FixedMethodGroupTargetDerived();
        fixedMgTarget.Factory = FixedGetBox;
        fixedMgTarget.Add(source[0]);

        var outVarFixed = new OutVarFixedDerived();
        outVarFixed.OutBox(out var outFixedBox);
        AcceptBox(outFixedBox);
        outVarFixed.Add(source[0]);
    }
}`
        const benignConsumerSource = `using ManagedArrayInheritedGenericBaseFixedDestination;
namespace BenignConsumer;
public class BenignProbe {
    public static CrossProjectDerived Create() => new CrossProjectDerived();
}`
        const consumerSource = `using Gsharp.Values;
using ManagedArrayInheritedGenericBaseFixedDestination;
namespace DownstreamConsumer;
public class ConsumerProbe {
    public static Base<ManagedRef<int>> Hold() => new CrossProjectDerived();
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayInheritedGenericBaseFixedDestination.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        using let peStream = System.IO.MemoryStream()
        Assert.True(project.Compilation.Emit(peStream).Success)
        let consumerReferences = List[MetadataReference](references)
        consumerReferences.Add(MetadataReference.CreateFromImage(peStream.ToArray()))
        let benignConsumerProject = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("BenignConsumer.cs", benignConsumerSource)},
            consumerReferences,
            assemblyName: "BenignConsumer"
        )
        Assert.True(
            benignConsumerProject.BoundWithoutErrors,
            string.Join(Environment.NewLine, benignConsumerProject.ErrorDiagnostics)
        )
        let consumerProject = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("Consumer.cs", consumerSource)},
            consumerReferences,
            assemblyName: "DownstreamConsumer"
        )
        Assert.True(
            consumerProject.BoundWithoutErrors,
            string.Join(Environment.NewLine, consumerProject.ErrorDiagnostics)
        )
        let document = Assert.Single(project.Documents)
        let benignContext = TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath,
            repositoryCompilations: []Microsoft
                .CodeAnalysis
                .CSharp
                .CSharpCompilation{project.Compilation, benignConsumerProject.Compilation}
        )
        let benignText = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, benignContext))
        Assert.Contains("open class CrossProjectDerived : Base[managed[int32]?]", benignText, StringComparison.Ordinal)
        let context = TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath,
            repositoryCompilations: []Microsoft.CodeAnalysis.CSharp.CSharpCompilation{consumerProject.Compilation}
        )
        {
            using let outerScope = context.UseSemanticModelFor(consumerProject.Compilation.SyntaxTrees[0])
            using let innerScope = context.UseSemanticModelFor(document.SyntaxTree)
            Assert.Same(project.Compilation, context.Compilation)
        }
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Equal(
            52,
            context.Diagnostics.Count(
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                    diagnostic.Message!!.Contains("fixed receiver storage", StringComparison.Ordinal)
            )
        )
        Assert.Equal(
            2,
            context.Diagnostics.Count(
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                    diagnostic.Message!!.Contains("fixed destination storage", StringComparison.Ordinal)
            )
        )
        Assert.Contains("open class Derived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class ConditionalDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class SwitchDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class BoxDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class ByRefCtorDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains(
            "open class PrimaryByRefCtorDerived(ref value managed[int32]) : Base[managed[int32]]",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains("open class ListCovariantDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class ArrayCovariantDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class OwnGenericDerived[U] : Base[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains("open class FixedMemberDerived : Base[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains("open class OverrideParentDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class EventOverrideParentDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains(
            "open class InterfaceDerived : Base[managed[int32]], IStore[managed[int32]]",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "open class InterfacePropertyDerived : Base[managed[int32]], IFixedProperty",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains("open class MethodGroupDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class IndexerDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class MultiLevelBoxDerived : Mid[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class LambdaMemberDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class MemberReadDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class ConditionalAccessDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class RefLocalDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class RefReturnDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class EventSubDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class ImplicitIndexerInitDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class LambdaParamDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class PartialWrapperDerived : Base[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains("open class ChainedReadDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains(
            "open class CollectionExprDerived : CollectionBase[managed[int32]]",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains("open class CoalesceAssignDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class ConstrainedDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class ForEachDerived : CollectionBase[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains(
            "open class NamedIndexerDerived : NamedIndexerBase[managed[int32]]",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains("open class ValueAssignDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class GenericExtDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class DelegateCallDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains(
            "open class ConstraintInstantiationDerived : Base[managed[int32]]",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains("open class AwaitDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class PatternDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class SuppressDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class CrossProjectDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains(
            "open class NestedConstraintInstantiationDerived : Base[managed[int32]]",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains("open class MethodConstraintDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class SwitchPatternDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class CoalesceValueDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains(
            "open class ConstrainedPairDerived : ConstrainedPairBase[managed[int32], Box[managed[int32]]]",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains("open class NestedConditionalDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class DeconstructDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains("open class LiftedTupleDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
        Assert.Contains(
            "open class InferredDeconstructFixedDerived : Base[managed[int32]]",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "open class UnderscoreLocalDeconstructDerived : Base[managed[int32]]",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "open class FixedMethodGroupTargetDerived : Base[managed[int32]]",
            text,
            StringComparison.Ordinal
        )
        Assert.Contains("open class OutVarFixedDerived : Base[managed[int32]]", text, StringComparison.Ordinal)
    }

    shared {
        private func TranslatePlain(source string)(
            Text string,
            Context TranslationContext
        ) -> ManagedReferenceTranslationTests.TranslatePlain(source)
    }
}
