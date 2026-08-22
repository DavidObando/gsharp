// <copyright file="ClrConstructorCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 4 exit — CLR class instantiation at call sites. Covers both
/// non-generic (<c>StringBuilder()</c>) and closed-generic
/// (<c>List[int]()</c>, <c>Dictionary[string, int]()</c>) imports through
/// the new <see cref="BoundClrConstructorCallExpression"/>.
/// </summary>
public class ClrConstructorCallTests
{
    [Fact]
    public void StringBuilder_DefaultConstructor_Binds()
    {
        var source = @"
import System.Text

var sb = StringBuilder()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ListInt_DefaultConstructor_Binds()
    {
        var source = @"
import System.Collections.Generic

var lst = List[int32]()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ListInt_WithNestedNonGenericSourceHomonym_BindsImportedGeneric()
    {
        var source = @"
package Demo
import System.Collections.Generic

class DocInline {
    class List {}
}

var lst = List[int32]()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ImportedTopLevelType_WithSameArityNestedSourceHomonym_BindsImportedType()
    {
        var source = @"
package Demo
import GSharp.Core.Tests.CodeAnalysis.Binding

class Holder {
    class Issue3466ImportedService {}
}

class Consumer {
    shared {
        func Read() int32 {
            let service = Issue3466ImportedService()
            return service.Value
        }
    }
}

var value = Consumer.Read()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ImportedGenericType_WithSameArityNestedSourceHomonym_BindsImportedType()
    {
        var source = @"
package Demo
import GSharp.Core.Tests.CodeAnalysis.Binding

class Holder {
    class Issue3466ImportedGenericService[T] {
        prop Value T
    }
}

class Consumer {
    shared {
        func Create() Issue3466ImportedGenericService[int32] {
            return Issue3466ImportedGenericService[int32](7)
        }

        func Read() int32 {
            return Create().Value
        }
    }
}

Consumer.Read()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void NestedGenericSourceHomonym_InContainingScope_TypeAnnotationWinsImportedType()
    {
        var source = @"
package Demo
import System.Collections.Generic

class Holder {
    class List[T] {
        prop SourceValue int32
    }

    shared {
        func Read(value List[int32]) int32 {
            return value.SourceValue
        }
    }
}

0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void EarlierNestedGenericHomonym_DoesNotAffectLexicalLookupAcrossPositions()
    {
        var source = @"
package Demo
import System.Collections.Generic

class Other {
    class List[T] {
        prop OtherValue int32
    }
}

class Holder {
    class List[T] {
        prop SourceValue int32 { get; set; }

        shared {
            prop StaticValue int32 { get; set; }
        }
    }

    shared {
        func Echo(value List[int32]) int32 {
            return value.SourceValue
        }

        func Read() int32 {
            let constructed = List[int32]()
            let initialized = List[int32]{SourceValue: 7}
            List[int32].StaticValue = 5
            List[int32].StaticValue += 1
            return constructed.SourceValue + Echo(initialized) + List[int32].StaticValue
        }
    }
}

Holder.Read()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(13, result.Value);
    }

    [Fact]
    public void EarlierNestedHomonym_StaticWriteAndColorColorUseLexicalType()
    {
        var source = @"
package Demo
import System

class Other {
    class Environment {
        shared {
            prop OtherCode int32 { get; set; }
        }
    }
}

class Holder {
    class Environment {
        shared {
            prop Code int32 { get; set; }
        }
    }

    var Environment string = ""shadow""

    func Read() int32 {
        Environment.Code = 7
        Environment.Code += 1
        return Environment.Code
    }
}

Holder().Read()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(8, result.Value);
    }

    [Fact]
    public void InheritedNestedGenericSourceHomonym_TypeAnnotationWinsImportedType()
    {
        var source = @"
package Demo
import System.Collections.Generic

open class Base[T] {
    protected class List[U] {
        prop SourceValue int32
    }
}

class Derived : Base[int32] {
    func Read(value List[int32]) int32 {
        return value.SourceValue
    }
}

0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void InheritedNestedGenericSourceHomonym_PreservesConstructedBaseSubstitution()
    {
        var source = @"
package Demo
import System.Collections.Generic

open class Base[T] {
    protected class List[U] {
        prop SourceValue T { get; set; }
    }
}

class Derived : Base[int32] {
    func Read(value List[string]) int32 {
        return value.SourceValue
    }

    func Build() int32 {
        let constructed = List[string]()
        constructed.SourceValue = 3
        let initialized = List[string]{SourceValue: 7}
        return Read(constructed) * 10 + Read(initialized)
    }
}

Derived().Build()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(37, result.Value);
    }

    [Fact]
    public void InaccessibleInheritedNestedGenericSourceHomonym_DoesNotOverrideImportedType()
    {
        var source = @"
package Demo
import System.Collections.Generic

open class Base {
    private class List[T] {
        prop SourceValue int32
    }
}

class Derived : Base {
    func Read(value List[int32]) int32 {
        return value.Count
    }
}

0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void TopLevelGenericSourceHomonym_TypeAnnotationWinsImportedType()
    {
        var source = @"
package Demo
import System.Collections.Generic

class List[T] {
    prop SourceValue int32
}

func Read(value List[int32]) int32 {
    return value.SourceValue
}

0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NestedGenericSourceHomonym_OutsideContainingScope_TypeAnnotationBindsImportedType()
    {
        var source = @"
package Demo
import System.Collections.Generic

class Holder {
    class List[T] {
        prop SourceValue int32
    }
}

func Read(value List[int32]) int32 {
    return value.Count
}

0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void WrongArityNestedSourceHomonym_DoesNotBlockImportedGenericTypeOrNestedType()
    {
        var source = @"
package Demo
import System.Collections.Generic

class Holder {
    class List {}

    shared {
        func Count(values List[int32]) int32 {
            return values.Count
        }

        func Current(enumerator List[int32].Enumerator) int32 {
            return enumerator.Current
        }
    }
}

0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ImportedGenericQualifiedType_WithSameArityNestedSourceHomonym_BindsImportedType()
    {
        var source = @"
package Demo
import GSharp.Core.Tests.CodeAnalysis.Binding

class Holder {
    class Issue3466ImportedGenericService[T] {
        class Token {
            prop SourceValue int32
        }
    }
}

func Read(value Issue3466ImportedGenericService[int32].Token) int32 {
    return value.ImportedValue
}

0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NestedGenericQualifiedSourceHomonym_InContainingScope_TypeAnnotationWinsImportedType()
    {
        var source = @"
package Demo
import GSharp.Core.Tests.CodeAnalysis.Binding

class Holder {
    class Issue3466ImportedGenericService[T] {
        class Token {
            prop SourceValue int32
        }
    }

    shared {
        func Read(value Issue3466ImportedGenericService[int32].Token) int32 {
            return value.SourceValue
        }
    }
}

0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ImportedGenericLiteral_WithMatchingNestedMembers_BindsImportedType()
    {
        var source = @"
package Demo
import GSharp.Core.Tests.CodeAnalysis.Binding

class Holder {
    class Issue3466ImportedGenericInitializer[T] {
        prop Value int32 { get; set; }
    }
}

let target = Issue3466ImportedGenericInitializer[string]{Value: 7}
target.Value
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(107, result.Value);
    }

    [Fact]
    public void ImportedGenericLiteral_WithWrongArityNestedSourceHomonym_BindsImportedType()
    {
        var source = @"
package Demo
import System.Threading

class Holder {
    class AsyncLocal {
        prop Value int32 { get; set; }
    }

    shared {
        func Read() string {
            let state = AsyncLocal[string]{Value: ""ok""}
            return state.Value
        }
    }
}

Holder.Read()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("ok", result.Value);
    }

    [Fact]
    public void NonGenericStaticReceiver_UsesNestedTypeInsideAndImportedTypeOutside()
    {
        var source = @"
package Demo
import System

class Holder {
    class String {
        shared {
            prop Empty int32 { get { return 7 } }
        }
    }

    shared {
        func ReadNested() int32 {
            return String.Empty
        }
    }
}

Holder.ReadNested() * 100 + String.Empty.Length
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(700, result.Value);
    }

    [Fact]
    public void ColorColorStaticReceiver_UsesImportedTypeOutsideNestedHomonymContainer()
    {
        var source = @"
package Demo
import System

class Holder {
    class String {
        shared {
            prop Empty int32 { get { return 7 } }
        }
    }
}

class Consumer {
    var String string = ""value""

    func Read() string {
        return String.Empty
    }
}

Consumer().Read()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(string.Empty, result.Value);
    }

    [Fact]
    public void StaticWrites_UseImportedTypeOutsideNestedHomonymContainer()
    {
        var source = @"
package Demo
import System

class Holder {
    class Environment {
        shared {
            prop ExitCode string { get { return ""nested"" } }
        }
    }
}

Environment.ExitCode = 0
Environment.ExitCode += 0
Environment.ExitCode
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void ImportedAlias_WithNestedSourceHomonym_BindsImportedTypeAtUnknownArity()
    {
        var source = @"
package Demo
import Service = GSharp.Core.Tests.CodeAnalysis.Binding.Issue3466ImportedService

class Holder {
    class Service {
        prop Value int32
    }
}

func Create() Service {
    return Service()
}

Create().Value
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void ImportedAliasLiteral_WithMatchingNestedMembers_BindsImportedType()
    {
        var source = @"
package Demo
import Service = GSharp.Core.Tests.CodeAnalysis.Binding.Issue3466ImportedInitializer

class Holder {
    class Service {
        prop Value int32 { get; set; }
    }
}

let target = Service{Value: 7}
target.Value
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(107, result.Value);
    }

    [Fact]
    public void NestedSourceHomonym_InContainingScope_TypeAnnotationWinsImportedAlias()
    {
        var source = NestedAliasScopeSource() + @"
func ReadImported(value Service) int32 {
    return value.Value
}

let nested = Holder.Service{Value: 7}
let imported = Service{Value: 7}
Holder.ReadNested(nested) * 1000 + ReadImported(imported)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7107, result.Value);
    }

    [Fact]
    public void NestedSourceHomonym_InContainingScope_ConstructorWinsImportedAlias()
    {
        var source = NestedAliasScopeSource() + @"
func ConstructImported() int32 {
    let value = Service()
    return value.Value
}

Holder.ConstructNested() * 1000 + ConstructImported()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(100, result.Value);
    }

    [Fact]
    public void NestedSourceHomonym_InContainingScope_LiteralWinsImportedAlias()
    {
        var source = NestedAliasScopeSource() + @"
func InitializeImported() int32 {
    let value = Service{Value: 7}
    return value.Value
}

Holder.InitializeNested() * 1000 + InitializeImported()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7107, result.Value);
    }

    [Fact]
    public void NestedSourceHomonym_StaticReadWinsImportedAliasInsideAndAliasWinsOutside()
    {
        var source = @"
package Demo
import Environment = System.Environment

class Holder {
    class Environment {
        shared {
            prop NewLine string { get { return ""nested"" } }
        }
    }

    shared {
        func ReadNested() string {
            return Environment.NewLine
        }
    }
}

func ReadImported() string {
    return Environment.NewLine
}

Holder.ReadNested() + ""|"" + ReadImported()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("nested|" + System.Environment.NewLine, result.Value);
    }

    [Fact]
    public void TopLevelSourceHomonym_StaticReadWinsImportedAlias()
    {
        var source = @"
package Demo
import Environment = System.Environment

class Environment {
    shared {
        prop NewLine string { get { return ""source"" } }
    }
}

Environment.NewLine
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("source", result.Value);
    }

    [Fact]
    public void NestedSourceHomonym_ColorColorStaticReadWinsImportedAlias()
    {
        var source = @"
package Demo
import Environment = System.Environment

class Holder {
    class Environment {
        shared {
            prop NewLine string { get { return ""nested"" } }
        }
    }

    var Environment string = ""shadow""

    func Read() string {
        return Environment.NewLine
    }
}

Holder().Read()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("nested", result.Value);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    public void ImportedAliasLookup_NonPositiveArity_ResolvesExactNonGenericTarget(int preferredArity)
    {
        using var resolver = ReferenceResolver.WithReferences(
            new[] { typeof(Issue3466ImportedService).Assembly.Location });
        var scope = new BoundScope(null, resolver);
        Assert.True(scope.TryImport(new ImportSymbol(
            "Service",
            typeof(Issue3466ImportedService).FullName!,
            declaration: null)));

        Assert.True(scope.TryLookupImportedClassByArity(
            "Service",
            preferredArity,
            declaration: null,
            out var imported));
        Assert.Equal(typeof(Issue3466ImportedService).FullName, imported.ClassType.FullName);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    public void ImportedGenericAliasLookup_NonPositiveArity_DoesNotResolveOpenType(int preferredArity)
    {
        using var resolver = ReferenceResolver.WithReferences(
            new[] { typeof(Issue3466ImportedGenericService<>).Assembly.Location });
        var scope = new BoundScope(null, resolver);
        string target = typeof(Issue3466ImportedGenericService<>).FullName!.Split('`')[0];
        Assert.True(scope.TryImport(new ImportSymbol("Service", target, declaration: null)));

        Assert.False(scope.TryLookupImportedClassByArity(
            "Service",
            preferredArity,
            declaration: null,
            out _));
        Assert.True(scope.TryLookupImportedClassByArity(
            "Service",
            preferredArity: 1,
            declaration: null,
            out var imported));
        Assert.True(imported.ClassType.IsGenericTypeDefinition);
    }

    [Fact]
    public void ImportedGeneric_WithUnknownArity_DoesNotOverrideNestedNonGenericType()
    {
        var source = @"
package Demo
import System.Collections.Generic

class Holder {
    class List {
        prop Value int32 { get; set; }
    }
}

let target = List{Value: 7}
target.Value
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void DictionaryStringInt_DefaultConstructor_Binds()
    {
        var source = @"
import System.Collections.Generic

var d = Dictionary[string, int32]()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void StringBuilder_WithCapacityArgument_Binds()
    {
        var source = @"
import System.Text

var sb = StringBuilder(16)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void StringBuilder_TooManyArguments_Diagnoses()
    {
        var source = @"
import System.Text

var sb = StringBuilder(""x"", ""y"", ""z"")
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static string NestedAliasScopeSource() => @"
package Demo
import Service = GSharp.Core.Tests.CodeAnalysis.Binding.Issue3466ImportedInitializer

class Holder {
    class Service {
        prop Value int32 { get; set; }
    }

    shared {
        func ReadNested(value Service) int32 {
            return value.Value
        }

        func ConstructNested() int32 {
            let value = Service()
            return value.Value
        }

        func InitializeNested() int32 {
            let value = Service{Value: 7}
            return value.Value
        }
    }
}
";

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}

public sealed class Issue3466ImportedService
{
    public Issue3466ImportedService()
    {
        this.Value = 7;
    }

    public int Value { get; }
}

public sealed class Issue3466ImportedGenericService<T>
{
    public Issue3466ImportedGenericService(T value)
    {
        this.Value = value;
    }

    public T Value { get; }

    public sealed class Token
    {
        public int ImportedValue => 11;
    }
}

public sealed class Issue3466ImportedGenericInitializer<T>
{
    private int value;

    public int Value
    {
        get => this.value + 100;
        set => this.value = value;
    }
}

public sealed class Issue3466ImportedInitializer
{
    private int value;

    public int Value
    {
        get => this.value + 100;
        set => this.value = value;
    }
}
