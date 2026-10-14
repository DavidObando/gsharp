// <copyright file="Doc.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting

import System
import System.Collections.Generic
import System.Text

/// Small Wadler/Oppen document algebra used by the canonical formatter.
internal abstract class Doc {
    private enum RenderMode {
        Flat,
        Break
    }

    private data struct RenderItem(Indentation int32, Mode RenderMode, Document Doc) : IEquatable[RenderItem] { }

    private class TextDoc : Doc {
        init(text string) {
            Value = text
        }

        prop Value string {
            get;
        }
    }

    private class LineDoc : Doc {
        init(flatText string) {
            FlatText = flatText
        }

        prop FlatText string {
            get;
        }
    }

    private class HardLineDoc : Doc { }

    private class ConcatDoc : Doc {
        init(left Doc, right Doc) {
            Left = left
            Right = right
        }

        prop Left Doc {
            get;
        }

        prop Right Doc {
            get;
        }
    }

    private class NestDoc : Doc {
        init(indentation int32, document Doc) {
            Indentation = indentation
            Document = document
        }

        prop Indentation int32 {
            get;
        }

        prop Document Doc {
            get;
        }
    }

    private class GroupDoc : Doc {
        init(document Doc) {
            Document = document
        }

        prop Document Doc {
            get;
        }
    }

    shared {
        private let _empty Doc = TextDoc(string.Empty)

        prop Empty Doc {
            get {
                return _empty
            }
        }

        private let _line Doc = LineDoc(" ")

        prop Line Doc {
            get {
                return _line
            }
        }

        private let _softLine Doc = LineDoc(string.Empty)

        prop SoftLine Doc {
            get {
                return _softLine
            }
        }

        private let _hardLine Doc = HardLineDoc()

        prop HardLine Doc {
            get {
                return _hardLine
            }
        }

        func Text(text string) Doc -> if string.IsNullOrEmpty(text) {
            Empty
        } else {
            cast[Doc](TextDoc(text))
        }

        func Concat(documents IEnumerable[Doc]) Doc {
            var result = Empty
            for document in documents {
                if !object.ReferenceEquals(document, Empty) {
                    result = if object.ReferenceEquals(result, Empty) {
                        document
                    } else {
                        cast[Doc](ConcatDoc(result, document))
                    }
                }
            }
            return result
        }

        func Concat(documents ...Doc) Doc -> Concat(cast[IEnumerable[Doc]](documents))

        func Nest(indentation int32, document Doc) Doc -> if indentation == 0 {
            document
        } else {
            cast[Doc](NestDoc(indentation, document))
        }

        func Group(document Doc) Doc -> GroupDoc(document)

        func Render(document Doc, width int32) string {
            let builder = StringBuilder()
            let pending = Stack[RenderItem]()
            pending.Push(RenderItem(0, RenderMode.Break, document))
            var column = 0
            var pendingIndentation = -1
            while pending.Count > 0 {
                let item = pending.Pop()
                switch item.Document {
                    case text is TextDoc {
                        if text.Value.Length > 0 && pendingIndentation >= 0 {
                            builder.Append(' ', pendingIndentation)
                            pendingIndentation = -1
                        }
                        builder.Append(text.Value)
                        let lastNewline = text.Value.LastIndexOf('\n')
                        column = if lastNewline < 0 {
                            column + text.Value.Length
                        } else {
                            text.Value.Length - lastNewline - 1
                        }
                    }
                    case line is LineDoc {
                        if item.Mode == RenderMode.Flat {
                            if line.FlatText.Length > 0 && pendingIndentation >= 0 {
                                builder.Append(' ', pendingIndentation)
                                pendingIndentation = -1
                            }
                            builder.Append(line.FlatText)
                            column += line.FlatText.Length
                        } else {
                            builder.Append('\n')
                            pendingIndentation = item.Indentation
                            column = item.Indentation
                        }
                    }
                    case HardLineDoc {
                        builder.Append('\n')
                        pendingIndentation = item.Indentation
                        column = item.Indentation
                    }
                    case concat is ConcatDoc {
                        pending.Push(RenderItem(item.Indentation, item.Mode, concat.Right))
                        pending.Push(RenderItem(item.Indentation, item.Mode, concat.Left))
                    }
                    case nest is NestDoc {
                        pending.Push(RenderItem(item.Indentation + nest.Indentation, item.Mode, nest.Document))
                    }
                    case group is GroupDoc {
                        let flat = RenderItem(item.Indentation, RenderMode.Flat, group.Document)
                        pending.Push(
                            if Fits(width - column, flat, pending) {
                                flat
                            } else {
                                RenderItem(item.Indentation, RenderMode.Break, group.Document)
                            }
                        )
                    }
                    default {
                        throw InvalidOperationException("Unknown document node.")
                    }
                }
            }
            return builder.ToString()
        }

        private func Fits(remaining int32, first RenderItem, rest Stack[RenderItem]) bool {
            var remaining = remaining
            let pending = Stack[RenderItem]()
            let remainingItems = rest.ToArray()
            for var i = remainingItems.Length - 1; i >= 0; i-- {
                pending.Push(remainingItems[i])
            }
            pending.Push(first)
            while remaining >= 0 && pending.Count > 0 {
                let item = pending.Pop()
                switch item.Document {
                    case text is TextDoc {
                        let newline = text.Value.IndexOf('\n')
                        if newline >= 0 {
                            return true
                        }
                        remaining -= text.Value.Length
                    }
                    case line is LineDoc {
                        if item.Mode == RenderMode.Flat {
                            remaining -= line.FlatText.Length
                        } else {
                            return true
                        }
                    }
                    case HardLineDoc {
                        return item.Mode != RenderMode.Flat
                    }
                    case concat is ConcatDoc {
                        pending.Push(RenderItem(item.Indentation, item.Mode, concat.Right))
                        pending.Push(RenderItem(item.Indentation, item.Mode, concat.Left))
                    }
                    case nest is NestDoc {
                        pending.Push(RenderItem(item.Indentation + nest.Indentation, item.Mode, nest.Document))
                    }
                    case group is GroupDoc {
                        // Inherit the mode instead of forcing flat. The item under
                        // test arrives flat and stays flat all the way down, which
                        // is what "does this group fit on one line" means; the items
                        // that follow it arrive in break mode, so measuring stops at
                        // the first line break they are still free to take. Forcing
                        // them flat measured the whole remaining statement instead,
                        // and a short leading group — `List[GStatement]` in front of
                        // a long argument list — was broken apart because something
                        // far to its right did not fit.
                        pending.Push(RenderItem(item.Indentation, item.Mode, group.Document))
                    }
                }
            }
            return remaining >= 0
        }
    }
}
