using System;
using System.Collections.Generic;

namespace Issue4802;

public sealed class Activation<T>
{
    private readonly T marker;

    public Activation(T marker) => this.marker = marker;

    public string RecursiveHelper()
    {
        var trail = new List<int>();
        int calls = 0;

        void Entry(int depth) => Collect(depth);

        void Collect(int depth)
        {
            int[] mapping = { depth * 10, depth * 10 + 1 };
            bool[] visited = { false, false };

            void VisitSlot(int index)
            {
                if (visited[index])
                {
                    return;
                }

                visited[index] = true;
                calls++;
                trail.Add(mapping[index]);
                if (index == 0 && depth > 0)
                {
                    Entry(depth - 1);
                }
            }

            VisitSlot(0);
            for (int index = 0; index < mapping.Length; index++)
            {
                VisitSlot(index);
            }
        }

        Entry(2);
        return string.Join(",", trail) + "|" + calls + "|" + marker;
    }

    public string NestedMutualAndEscapes()
    {
        var saved = new List<Func<int, int>>();
        var resumed = new List<int>();

        void Entry(int depth) => Collect(depth);

        void Collect(int depth)
        {
            int First(int count) => count == 0 ? depth : Second(count - 1);

            int Second(int count)
            {
                if (count > 0)
                {
                    return First(count - 1);
                }

                if (depth > 0)
                {
                    Entry(depth - 1);
                }

                return depth;
            }

            saved.Add(First);
            Second(0);
            resumed.Add(First(2));
        }

        Entry(2);
        var escaped = new List<int>();
        foreach (var callback in saved)
        {
            escaped.Add(callback(2));
        }

        return string.Join(",", resumed) + "|" + string.Join(",", escaped);
    }

    public string OuterMutualThroughNestedBridge()
    {
        var trail = new List<int>();

        void Second(int depth)
        {
            trail.Add(depth + 20);
            First(depth);
        }

        void First(int depth)
        {
            void Bridge()
            {
                trail.Add(depth);
                if (depth > 0)
                {
                    Second(depth - 1);
                }
            }

            Bridge();
            trail.Add(depth + 10);
        }

        First(2);
        return string.Join(",", trail);
    }
}
