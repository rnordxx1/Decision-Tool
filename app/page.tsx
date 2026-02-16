import { redirect } from 'next/navigation'

export default function Home() {
  // Redirect the root route to the login page by default
  redirect('/login')
}