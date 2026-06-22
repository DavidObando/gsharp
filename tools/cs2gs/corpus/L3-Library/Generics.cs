// L3-Library, part 1: generics with constraints, a generic method with
// inference, an indexer, and nullable reference types.
//
// Exercises (ADR-0115 section B):
//   B.7  generics + constraints: `where T : ...` -> bracketed G# constraints
//   B.10 visibility
//   B.11 indexer, properties
//   nullable reference types (Nullable=enable)
using System;
using System.Collections;
using System.Collections.Generic;

namespace Corpus.L3
{
    // Generic class with a constraint: where T : notnull.
    public sealed class Repository<T> : IEnumerable<T>
        where T : notnull
    {
        private readonly List<T> _items = new();

        public int Count => _items.Count;

        // Indexer -> G# indexer member.
        public T this[int index] => _items[index];

        public void Add(T item) => _items.Add(item);

        public bool Contains(T item) => _items.Contains(item);

        public IEnumerator<T> GetEnumerator() => _items.GetEnumerator();

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    // Constraint: where T : IComparable<T>.
    public static class Algorithms
    {
        public static T Max<T>(IReadOnlyList<T> values)
            where T : IComparable<T>
        {
            if (values.Count == 0)
            {
                throw new ArgumentException("values must be non-empty", nameof(values));
            }

            T best = values[0];
            for (int i = 1; i < values.Count; i++)
            {
                if (values[i].CompareTo(best) > 0)
                {
                    best = values[i];
                }
            }

            return best;
        }

        // Generic method whose T is inferred at the call site.
        public static (T First, T Last) Ends<T>(IReadOnlyList<T> values)
        {
            if (values.Count == 0)
            {
                throw new ArgumentException("values must be non-empty", nameof(values));
            }

            return (values[0], values[values.Count - 1]);
        }

        // Constraint: where T : class - nullable reference flow.
        public static T OrDefault<T>(T? value, T fallback)
            where T : class
        {
            return value ?? fallback;
        }
    }
}
