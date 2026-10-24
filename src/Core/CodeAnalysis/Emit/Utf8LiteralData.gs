package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

internal class Utf8LiteralData {
    private let blobs SortedDictionary[string, ImmutableArray[uint8]] = SortedDictionary[string, ImmutableArray[uint8]](
        StringComparer.Ordinal
    )
    private let fields Dictionary[string, FieldDefinitionHandle] = Dictionary[string, FieldDefinitionHandle](
        StringComparer.Ordinal
    )
    private var firstFieldRow int32

    prop Data BlobBuilder {
        get;
    }
    prop HasData bool -> this.blobs.Count != 0

    init(program BoundProgram, metadataOnly bool) {
        this.Data = BlobBuilder()
        if metadataOnly {
            return
        }
        let collector = Collector(this.blobs)
        collector.Visit(program.Statement)
        for entry in BoundProgramOrder.Functions(program) {
            collector.Visit(entry.Value)
        }
        for entry in BoundProgramOrder.Initializers(program) {
            collector.Visit(entry.Value.Prologue)
            for argument in entry.Value.Arguments {
                collector.Visit(argument)
            }
            collector.Visit(entry.Value.Body)
        }
        for type in program.Structs {
            for entry in type.InstanceFieldInitializers {
                collector.Visit(entry.Value)
            }
            for entry in type.StaticFieldInitializers {
                collector.Visit(entry.Value)
            }
            for statement in type.StaticInitializerStatements {
                collector.Visit(statement)
            }
            if type.BaseConstructorInitializer is {} initializer {
                for argument in initializer.Arguments {
                    collector.Visit(argument)
                }
            }
            for constructor in type.ExplicitConstructors {
                if constructor.BaseInitializer is {} initializer {
                    for argument in initializer.Arguments {
                        collector.Visit(argument)
                    }
                }
            }
        }
        for type in program.Interfaces {
            for entry in type.StaticFieldInitializers {
                collector.Visit(entry.Value)
            }
        }
    }

    func PlanFields(nextFieldRow int32) {
        this.firstFieldRow = nextFieldRow
        var row = nextFieldRow
        for entry in this.blobs {
            this.fields.Add(entry.Key, MetadataTokens.FieldDefinitionHandle(row++))
        }
    }

    func GetField(literal BoundUtf8StringExpression) FieldDefinitionHandle ->
    this.fields[Convert.ToHexString(literal.Bytes.AsSpan()) + "00"]

    func Emit(metadata MetadataBuilder, objectType EntityHandle, valueType EntityHandle) {
        if this.blobs.Count == 0 {
            return
        }
        if metadata.GetRowCount(TableIndex.Field) + 1 != this.firstFieldRow {
            throw InvalidOperationException("UTF-8 data fields do not follow the complete planned source fields.")
        }
        let methodList = MetadataTokens.MethodDefinitionHandle(metadata.GetRowCount(TableIndex.MethodDef) + 1)
        let owner = metadata.AddTypeDefinition(
            TypeAttributes.NotPublic | TypeAttributes.Abstract | TypeAttributes.Sealed | TypeAttributes.BeforeFieldInit,
            default(StringHandle),
            metadata.GetOrAddString("<PrivateImplementationDetails>__Utf8"),
            objectType,
            MetadataTokens.FieldDefinitionHandle(this.firstFieldRow),
            methodList
        )
        let sizes = SortedSet[int32]()
        for entry in this.blobs {
            sizes.Add(entry.Value.Length + 1)
        }
        let sizeTypes = Dictionary[int32, TypeDefinitionHandle]()
        let afterFields = MetadataTokens.FieldDefinitionHandle(this.firstFieldRow + this.blobs.Count)
        for size in sizes {
            let type = metadata.AddTypeDefinition(
                TypeAttributes.NestedPrivate | TypeAttributes.ExplicitLayout | TypeAttributes.Sealed | TypeAttributes.BeforeFieldInit,
                default(StringHandle),
                metadata.GetOrAddString("__Utf8Bytes_" + size.ToString(CultureInfo.InvariantCulture)),
                valueType,
                afterFields,
                methodList
            )
            metadata.AddNestedType(type, owner)
            metadata.AddTypeLayout(type, packingSize: 1, size: uint32(size))
            sizeTypes.Add(size, type)
        }
        var ordinal = 0
        for entry in this.blobs {
            let signature = BlobBuilder()
            BlobEncoder(signature).FieldSignature().Type(sizeTypes[entry.Value.Length + 1], isValueType: true)
            let field = metadata.AddFieldDefinition(
                FieldAttributes.Private | FieldAttributes.Static | FieldAttributes.InitOnly | FieldAttributes.HasFieldRVA,
                metadata.GetOrAddString("__Utf8_" + ordinal.ToString(CultureInfo.InvariantCulture)),
                metadata.GetOrAddBlob(signature)
            )
            if field != this.fields[entry.Key] {
                throw InvalidOperationException("UTF-8 field rows changed after deterministic planning.")
            }
            metadata.AddFieldRelativeVirtualAddress(field, this.Data.Count)
            this.Data.WriteBytes(entry.Value)
            this.Data.WriteByte(0)
            ordinal++
        }
    }

    private class Collector : BoundTreeWalker {
        private let blobs SortedDictionary[string, ImmutableArray[uint8]]

        init(blobs SortedDictionary[string, ImmutableArray[uint8]]) {
            this.blobs = blobs
        }

        override func VisitExpression(node BoundExpression?) {
            if node is BoundUtf8StringExpression literal {
                let key = Convert.ToHexString(literal.Bytes.AsSpan()) + "00"
                if !this.blobs.ContainsKey(key) {
                    this.blobs.Add(key, literal.Bytes)
                }
            } else if node is BoundFunctionLiteralExpression lambda {
                Visit(lambda.Body)
            }
            base.VisitExpression(node)
        }
    }
}
