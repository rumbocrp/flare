import { useEffect, useRef, useState } from 'react'

export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const element = ref.current
    if (!element) return undefined

    const observer = new ResizeObserver((entries) => {
      setWidth(Math.floor(entries[0].contentRect.width))
    })
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  return [ref, width] as const
}

export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const element = ref.current
    if (!element) return undefined

    const update = (width: number, height: number) => {
      const w = Math.floor(width)
      const h = Math.floor(height)
      setSize((prev) =>
        prev.width === w && prev.height === h ? prev : { width: w, height: h },
      )
    }

    const rect = element.getBoundingClientRect()
    update(rect.width, rect.height)

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      update(entry.contentRect.width, entry.contentRect.height)
    })
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  return [ref, size] as const
}
