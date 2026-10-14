// <copyright file="ChannelTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Concurrent
import System.Diagnostics.CodeAnalysis
import System.Threading.Channels

/// Represents a channel type clause: `chan[T]`, `in chan[T]`, or
/// `out chan[T]` (ADR-0174 D1/D2).
/// @remarks The <em>type</em> stays identity-transparent to its BCL backing —
/// `chan[T]` is `System.Threading.Channels.Channel<T>`,
/// `in chan[T]` is `ChannelReader<T>`, `out chan[T]` is
/// `ChannelWriter<T>` — so every foreign channel from C# or NuGet
/// is assignable to it. What the <em>expression</em> `chan[T](…)`
/// constructs is the runtime's `Gsharp.Concurrency.Chan<T>`, a
/// subclass that carries the Go-exact machinery; that constructed type is
/// an ordinary imported symbol, and (cref:TryGetChannelShape) is the
/// one place that recognizes every channel-shaped type.
///
/// Instances are cached per (element type, direction) so identical
/// channel types compare by reference.
class ChannelTypeSymbol : TypeSymbol {
    private init(elementType TypeSymbol, direction ChannelDirection) : base(
        FormatName(elementType.Name, direction),
        MakeClrType(elementType, direction)
    ) {
        ElementType = elementType
        Direction = direction
    }

    /// Gets the channel element type.
    prop ElementType TypeSymbol {
        get;
    }

    /// Gets the channel direction.
    prop Direction ChannelDirection {
        get;
    }

    /// Gets a value indicating whether this is an `in chan[T]` (receive-only) handle.
    prop IsReceiveOnly bool -> Direction == ChannelDirection.In

    /// Gets a value indicating whether this is an `out chan[T]` (send-only) handle.
    prop IsSendOnly bool -> Direction == ChannelDirection.Out

    shared {
        /// The full name of the runtime's constructed channel class.
        const ConstructedChannelFullName string = "Gsharp.Concurrency.Chan`1"

        private const ChannelFullName string = "System.Threading.Channels.Channel`1"
        private const ChannelReaderFullName string = "System.Threading.Channels.ChannelReader`1"
        private const ChannelWriterFullName string = "System.Threading.Channels.ChannelWriter`1"
        private let Cache ConcurrentDictionary[
            (Element TypeSymbol, Direction ChannelDirection),
            ChannelTypeSymbol
        ] = ConcurrentDictionary[(Element TypeSymbol, Direction ChannelDirection), ChannelTypeSymbol]()

        /// Gets or creates the bidirectional channel type symbol for the given element type.
        /// @param elementType The element type.
        /// @returns The cached (cref:ChannelTypeSymbol).
        func Get(elementType TypeSymbol) ChannelTypeSymbol -> Get(elementType, ChannelDirection.Both)

        /// Gets or creates the channel type symbol for the given element type and direction.
        /// @param elementType The element type.
        /// @param direction The direction.
        /// @returns The cached (cref:ChannelTypeSymbol).
        func Get(elementType TypeSymbol?, direction ChannelDirection) ChannelTypeSymbol {
            if elementType == nil {
                throw ArgumentNullException("elementType")
            }
            return Cache.GetOrAdd(
                (elementType, direction),
                (key(Element TypeSymbol, Direction ChannelDirection)) -> ChannelTypeSymbol(key.Element, key.Direction)
            )
        }

        /// Recognizes every channel-shaped type the operation matrix (ADR-0174 D2)
        /// covers: the magic `chan[T]` symbols, the runtime's constructed
        /// `Chan<T>`, and foreign BCL `Channel<T>` /
        /// `ChannelReader<T>` / `ChannelWriter<T>`. A nullable
        /// wrapper is looked through: a `nil` channel blocks forever, which is
        /// what makes disabled `select` arms work.
        /// @param type The operand type.
        /// @param elementType The element type.
        /// @param direction The direction the handle permits.
        /// @param isConstructed True when the type is the runtime's `Chan<T>` (the fast path).
        /// @returns True when [`type`](paramref) is channel-shaped.
        func TryGetChannelShape(
            type TypeSymbol?,
            @NotNullWhen(true) out elementType TypeSymbol?,
            out direction ChannelDirection,
            out isConstructed bool
        ) bool {
            elementType = nil
            direction = ChannelDirection.Both
            isConstructed = false
            switch type {
                case nil {
                    return false
                }
                case nullable is NullableTypeSymbol {
                    return TryGetChannelShape(
                        nullable.UnderlyingType,
                        out elementType,
                        out direction,
                        out isConstructed
                    )
                }
                case platform is PlatformTypeSymbol {
                    return TryGetChannelShape(
                        platform.UnderlyingType,
                        out elementType,
                        out direction,
                        out isConstructed
                    )
                }
                case annotated is NullabilityAnnotatedTypeSymbol {
                    return TryGetChannelShape(annotated.BaseType, out elementType, out direction, out isConstructed)
                }
                case channel is ChannelTypeSymbol {
                    elementType = channel.ElementType
                    direction = channel.Direction
                    return true
                }
                case imported is ImportedTypeSymbol {
                    {
                        var open_ Type? = imported.OpenDefinition
                        if open_ == nil && imported.ClrType is {IsGenericType: true} closed {
                            open_ = closed.GetGenericTypeDefinition()
                        }
                        switch open_?.FullName {
                            case ConstructedChannelFullName {
                                isConstructed = true
                                direction = ChannelDirection.Both
                            }
                            case ChannelFullName {
                                direction = ChannelDirection.Both
                            }
                            case ChannelReaderFullName {
                                direction = ChannelDirection.In
                            }
                            case ChannelWriterFullName {
                                direction = ChannelDirection.Out
                            }
                            default {
                                return false
                            }
                        }
                        if !imported.TypeArguments.IsDefaultOrEmpty {
                            elementType = imported.TypeArguments[0]
                            return true
                        }
                        if imported.ClrType is {IsGenericType: true} closedShape {
                            elementType = TypeSymbol.FromClrTypeWithoutNullability(
                                closedShape.GetGenericArguments()[0],
                                NullabilityFreeReason.TypeStructure
                            )
                            return elementType != nil
                        }
                        return false
                    }
                }
                default {
                    return false
                }
            }
        }

        /// Recognizes a channel-shaped type by the full name of its <em>open</em>
        /// generic definition — the runtime's `Chan<>` plus the three BCL
        /// views `Channel<>` / `ChannelReader<>` /
        /// `ChannelWriter<>`.
        /// @remarks This is the name-only companion to (cref:TryGetChannelShape), for
        /// the layers that work on raw reflection (cref:Type) surrogates
        /// rather than on symbols. Comparing full names is what keeps it correct
        /// across reflection contexts, where a reference-loaded
        /// `ChannelReader`1` is not reference-equal to the host's.
        /// @param openDefinitionFullName The candidate open definition's (cref:Type.FullName).
        /// @returns True when the name is one of the four channel-shaped definitions.
        internal func IsChannelClrDefinitionName(openDefinitionFullName string?) bool -> switch openDefinitionFullName {
            case ConstructedChannelFullName: true
            case ChannelFullName: true
            case ChannelReaderFullName: true
            case ChannelWriterFullName: true
            default: false
        }

        /// Gets the open BCL generic definition a direction binds to.
        /// @param direction The direction.
        /// @returns `Channel<>`, `ChannelReader<>`, or `ChannelWriter<>`.
        internal func OpenClrDefinition(direction ChannelDirection) Type -> switch direction {
            case ChannelDirection.In: typeof(ChannelReader[_])
            case ChannelDirection.Out: typeof(ChannelWriter[_])
            default: typeof(Channel[_])
        }

        /// Formats the G# spelling of a channel type over an already-formatted element.
        /// @param elementText The element type's display text.
        /// @param direction The direction.
        /// @returns The spelling.
        internal func FormatName(elementText string, direction ChannelDirection) string -> switch direction {
            case ChannelDirection.In: "in chan[$elementText]"
            case ChannelDirection.Out: "out chan[$elementText]"
            default: "chan[$elementText]"
        }

        /// Removes all entries from the static type cache. Called by
        /// (cref:ReferenceResolver.Dispose) to release stale
        /// (cref:Type) objects backed by a disposed metadata load context
        /// that would otherwise pin the context's memory indefinitely.
        internal func ClearCache() -> Cache.Clear()

        private func MakeClrType(elementType TypeSymbol, direction ChannelDirection) Type? {
            if elementType.ClrType == nil {
                return nil
            }
            return OpenClrDefinition(direction).MakeGenericType(elementType.ClrType)
        }
    }
}
